import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type AuthenticationChallenge,
} from '../src/generated/prisma/client';

import { AuthModule } from '../src/auth/auth.module';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeProofEncryptionService } from '../src/auth/challenge/services/authentication-challenge-proof-encryption.service';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AuthenticationChallengeVerificationService } from '../src/auth/challenge/services/authentication-challenge-verification.service';
import { AuthenticationEmailProviderPort } from '../src/auth/delivery/ports/authentication-email-provider.port';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import { AuthenticationDeliveryPolicyService } from '../src/auth/delivery/services/authentication-delivery-policy.service';
import { AuthenticationMagicLinkService } from '../src/auth/delivery/services/authentication-magic-link.service';
import type {
  AuthenticationEmailProviderResult,
  AuthenticationEmailSubmission,
} from '../src/auth/delivery/types/authentication-email-provider.type';
import { AuthenticationOperationService } from '../src/auth/operations/services/authentication-operation.service';
import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
} from '../src/auth/operations/types/authentication-operation.type';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { validateEnvironment } from '../src/config/environment.validation';
import { HttpRateLimitModule } from '../src/http-rate-limit/http-rate-limit.module';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY } from '../src/http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { HttpRequestRateLimitConfigService } from '../src/http-rate-limit/services/http-request-rate-limit-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
} from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';
import type {
  GcraState,
  GcraTime,
} from '../src/rate-limit/types/gcra-state.type';
import type { RateLimitBucketPolicy } from '../src/rate-limit/types/rate-limit-bucket-key.type';

const verificationPolicies = [
  policies.verificationIdentityShortTerm,
  policies.verificationIdentityLongTerm,
  policies.verificationIpShortTerm,
  policies.verificationIpLongTerm,
];
const deliveryPolicies = [policies.deliveryIdentity, policies.deliveryIp];
type RateName =
  | 'verificationIdentityShortTerm'
  | 'verificationIdentityLongTerm'
  | 'verificationIpShortTerm'
  | 'verificationIpLongTerm'
  | 'deliveryIdentity';

describe('Verification, request/reuse and Delivery lifecycle (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  const primaryName = `verification_primary_${randomUUID().replaceAll('-', '')}`;
  const replicaName = `verification_rival_${randomUUID().replaceAll('-', '')}`;
  let requests: AuthenticationChallengeRequestService,
    resendAdmission: AuthenticationDeliveryAdmissionService;
  let replicaCleanup: AuthenticationChallengeCleanupRepository;
  let operations: AuthenticationOperationService,
    verifier: AuthenticationChallengeVerificationService;
  let encryption: AuthenticationChallengeProofEncryptionService,
    worker: AuthenticationDeliveryOrchestrationService;
  let deliveries: AuthenticationDeliveryRepository,
    cleanup: AuthenticationChallengeCleanupRepository;
  let derivation: RateLimitBucketKeyService,
    gcra: GcraAdmissionRepository,
    requestAdmission: GcraAdmissionService;
  let rates: AuthenticationRateLimitConfigService,
    requestConfig: HttpRequestRateLimitConfigService;
  let cooldown: AuthenticationDeliveryCooldownRepository;
  let identity: string, ipAddress: string;
  const identities = new Set<string>(),
    ownerSubjects = new Set<string>();
  const challengeIds = new Set<string>(),
    operationIds = new Set<string>(),
    ownedKeys = new Set<string>();
  // Only the external provider is replaced. Crypto, transactions, admissions,
  // operation receipts, cleanup, rendering and worker persistence are real.
  const provider = {
    submit: jest.fn<
      Promise<AuthenticationEmailProviderResult>,
      [AuthenticationEmailSubmission]
    >(),
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnvironment,
        }),
        AuthModule,
        HttpRateLimitModule,
      ],
    })
      .overrideProvider(AuthenticationEmailProviderPort)
      .useValue(provider)
      .compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Dedicated test database required.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    requests = module.get(AuthenticationChallengeRequestService);
    resendAdmission = module.get(AuthenticationDeliveryAdmissionService);
    replicaCleanup = new AuthenticationChallengeCleanupRepository(replica);
    operations = module.get(AuthenticationOperationService);
    verifier = module.get(AuthenticationChallengeVerificationService);
    encryption = module.get(AuthenticationChallengeProofEncryptionService);
    worker = module.get(AuthenticationDeliveryOrchestrationService);
    deliveries = module.get(AuthenticationDeliveryRepository);
    cleanup = module.get(AuthenticationChallengeCleanupRepository);
    derivation = module.get(RateLimitBucketKeyService);
    gcra = module.get(GcraAdmissionRepository);
    requestAdmission = module.get(GcraAdmissionService);
    rates = module.get(AuthenticationRateLimitConfigService);
    requestConfig = module.get(HttpRequestRateLimitConfigService);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
  });
  beforeEach(() => {
    identity = `verification-lifecycle-${randomUUID()}@example.edu`;
    identities.add(identity);
    ipAddress = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
    provider.submit.mockReset().mockResolvedValue({ outcome: 'ACCEPTED' });
    [
      ...verificationPolicies,
      ...deliveryPolicies,
      policies.identityDeliveryCooldown,
      PUBLIC_PASSWORDLESS_REQUEST_POLICY,
    ].forEach((policy) => keys(policy));
  });
  afterEach(async () => {
    await prisma.authenticationOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.authenticationChallenge.deleteMany({
      where: { normalizedIdentity: { in: [...identities] } },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: {
        OR: [
          { normalizedIdentity: { in: [...identities] } },
          { key: { in: [...ownerSubjects] } },
        ],
      },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    identities.clear();
    ownerSubjects.clear();
    challengeIds.clear();
    operationIds.clear();
    ownedKeys.clear();
    provider.submit.mockReset();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function keys(policy: RateLimitBucketPolicy, challengeId?: string) {
    const characteristic =
      policy.characteristicKind === 'IDENTITY'
        ? identity
        : policy.characteristicKind === 'IP'
          ? ipAddress
          : challengeId;
    const result = derivation
      .deriveKeys(policy, characteristic)
      .buckets.map((bucket) => bucket.key);
    result.forEach((key) => ownedKeys.add(key));
    return result;
  }
  async function execute(request: AuthenticationOperationRequest) {
    const operationId = await operations.createOperationId();
    operationIds.add(operationId);
    const response = await operations.execute(operationId, request);
    if ('challengeId' in response.result) {
      challengeIds.add(response.result.challengeId);
      keys(policies.challengeDeliveryCooldown, response.result.challengeId);
    }
    return response;
  }
  function signIn(): AuthenticationOperationRequest {
    return {
      kind: 'SIGN_IN_REQUEST',
      input: {
        normalizedIdentity: identity,
        ipAddress,
        templateProtocolVersion: 1,
      },
    };
  }
  function resend(
    challenge: AuthenticationChallenge,
  ): AuthenticationOperationRequest {
    return {
      kind: 'RESEND',
      input: {
        challengeId: challenge.id,
        ipAddress,
        templateProtocolVersion: 1,
        retentionExpiresAt: challenge.retentionExpiresAt,
      },
    };
  }
  async function initial() {
    const request = signIn(),
      response = await execute(request);
    if (response.result.outcome !== 'CREATED')
      throw new Error('Expected initial admission.');
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: response.result.challengeId },
    });
    return { request, response, challenge, proof: recover(challenge) };
  }
  function recover(challenge: AuthenticationChallenge) {
    if (
      !challenge.encryptedProof ||
      !challenge.proofEncryptionIv ||
      !challenge.proofEncryptionTag
    )
      throw new Error('Expected live envelope.');
    return encryption.decrypt(
      {
        challengeId: challenge.id,
        normalizedIdentity: challenge.normalizedIdentity,
        purpose: challenge.purpose,
      },
      {
        encryptedProof: challenge.encryptedProof,
        proofEncryptionIv: challenge.proofEncryptionIv,
        proofEncryptionTag: challenge.proofEncryptionTag,
        encryptionProtocolVersion: challenge.encryptionProtocolVersion,
        encryptionKeyVersion: challenge.encryptionKeyVersion,
      },
    );
  }
  function transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    client = prisma,
  ) {
    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout','5s',true)`;
        await tx.$executeRaw`SELECT set_config('application_name',${client === replica ? replicaName : primaryName},true)`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
  function verify(
    challenge: AuthenticationChallenge,
    proof: string,
    link = false,
  ) {
    return transaction((tx) =>
      link
        ? verifier.verifyAndConsumeMagicLinkInTransaction(tx, {
            challengeId: challenge.id,
            expectedPurpose: 'SIGN_IN',
            expectedBoundSessionId: null,
            ipAddress,
            proof,
          })
        : verifier.verifyAndConsumeOtpInTransaction(tx, {
            challengeId: challenge.id,
            expectedPurpose: 'SIGN_IN',
            expectedBoundSessionId: null,
            ipAddress,
            proof,
          }),
    );
  }
  async function exhaustVerification(
    challenge: AuthenticationChallenge,
    correctOtp: string,
  ) {
    const wrong = correctOtp === '999999' ? '999998' : '999999';
    for (let i = 0; i < 6; i++)
      expect(await verify(challenge, wrong)).toMatchObject({
        status: 'INVALID_PROOF',
        kind: 'MISMATCH',
        failedAttemptCount: i + 1,
        locked: false,
      });
    expect(await verify(challenge, correctOtp)).toMatchObject({
      status: 'RATE_LIMITED',
    });
  }
  async function process(deliveryId: string) {
    const claim = await deliveries.claimNextDelivery();
    expect(claim?.id).toBe(deliveryId);
    expect(await worker.process(claim!)).toEqual({ outcome: 'SENT' });
  }
  async function allowCooldown(challengeId: string) {
    // Explicit historical interval fixture, not a claim of elapsed wall time.
    // Neither proof, expiry, GCRA TAT nor operation receipts are altered.
    const now = await gcra.operationNowMicros(prisma);
    await transaction((tx) =>
      cooldown.writeAliases(
        tx,
        [
          ...keys(policies.identityDeliveryCooldown),
          ...keys(policies.challengeDeliveryCooldown, challengeId),
        ],
        now - 1n,
      ),
    );
  }
  async function seedBoundary(name: RateName, boundary: bigint) {
    const settings = rates[name],
      policy = policies[name];
    const debt = createGcraState(
      {
        numerator:
          boundary * BigInt(settings.rate) +
          BigInt(settings.burst - 1) *
            BigInt(settings.periodSeconds) *
            1_000_000n,
        denominator: BigInt(settings.rate),
      },
      settings,
    );
    await transaction((tx) =>
      gcra.writeAliases(tx, keys(policy), policy.id, debt),
    );
  }
  function rateState(policiesToRead: readonly RateLimitBucketPolicy[]) {
    return prisma.gcraRateLimit.findMany({
      where: { key: { in: policiesToRead.flatMap((policy) => keys(policy)) } },
      orderBy: { key: 'asc' },
    });
  }
  async function state() {
    return {
      challenges: await prisma.authenticationChallenge.findMany({
        where: { normalizedIdentity: identity },
        orderBy: { id: 'asc' },
      }),
      deliveries: await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId: { in: [...challengeIds] } },
        orderBy: { id: 'asc' },
      }),
      receipts: await prisma.authenticationOperation.findMany({
        where: { id: { in: [...operationIds] } },
        orderBy: { id: 'asc' },
      }),
      cd: await prisma.$queryRaw<
        { key: string; boundary: string; updated: string }[]
      >(
        Prisma.sql`SELECT "key", "windowEndAt"::text AS boundary, "updatedAt"::text AS updated FROM "AuthenticationRateLimit" WHERE "key" IN (${Prisma.join([...ownedKeys])}) ORDER BY "key"`,
      ),
      gcra: await prisma.gcraRateLimit.findMany({
        where: { key: { in: [...ownedKeys] } },
        orderBy: { key: 'asc' },
      }),
    };
  }
  function expectSameDomain(
    before: Awaited<ReturnType<typeof state>>,
    after: Awaited<ReturnType<typeof state>>,
  ) {
    expect(after.challenges).toEqual(before.challenges);
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.cd).toEqual(before.cd);
    expect(after.gcra).toEqual(before.gcra);
  }
  function created(response: AuthenticationOperationResponse) {
    if (response.result.outcome !== 'CREATED')
      throw new Error('Expected Delivery creation.');
    return response.result;
  }

  it.each(['PENDING', 'SENT'] as const)(
    'reuses the same rate-denied challenge with %s INITIAL and replays its original receipt without any new work',
    async (status) => {
      const first = await initial();
      if (status === 'SENT') await process(created(first.response).deliveryId);
      await exhaustVerification(first.challenge, first.proof.otp);
      const before = await state();
      const reused = await execute(signIn());
      expect(reused.result).toEqual({
        outcome: 'REUSED',
        challengeId: first.challenge.id,
        challengeExpiresAt: first.challenge.expiresAt,
      });
      const afterReuse = await state();
      expectSameDomain(before, afterReuse);
      expect(afterReuse.receipts).toHaveLength(before.receipts.length + 1);
      expect(
        afterReuse.receipts.filter((row) => row.id !== reused.operationId),
      ).toEqual(before.receipts);
      const replay = await operations.execute(
        first.response.operationId,
        first.request,
      );
      expect(replay).toMatchObject({
        replayed: true,
        result: first.response.result,
      });
      expect(await state()).toEqual(afterReuse);
      expect(recover(afterReuse.challenges[0])).toEqual(first.proof);
    },
  );

  it('resolves unfinished INITIAL under verification denial and active cooldown without moving work or any budget', async () => {
    const first = await initial();
    await exhaustVerification(first.challenge, first.proof.otp);
    const before = await state(),
      response = await execute(resend(first.challenge));
    expect(response.result).toEqual({
      outcome: 'EXISTING',
      challengeId: first.challenge.id,
      deliveryId: created(first.response).deliveryId,
      deliveryOrigin: 'INITIAL',
    });
    const after = await state();
    expectSameDomain(before, after);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(
      await operations.reconcile(response.operationId, resend(first.challenge)),
    ).toMatchObject({
      status: 'COMMITTED',
      response: { replayed: true, result: response.result },
    });
    expect(await state()).toEqual(after);
  });

  it('admits and sends stable-proof RESEND while verification is denied, charging only Delivery policies and advancing their cooldowns once', async () => {
    const first = await initial();
    await process(created(first.response).deliveryId);
    await exhaustVerification(first.challenge, first.proof.otp);
    await allowCooldown(first.challenge.id);
    const before = await state(),
      verificationBefore = await rateState(verificationPolicies),
      deliveryBefore = await rateState(deliveryPolicies);
    const request = resend(first.challenge),
      response = await execute(request),
      admission = created(response);
    expect(admission.deliveryOrigin).toBe('RESEND');
    expect(admission.deliveryId).not.toBe(created(first.response).deliveryId);
    const afterAdmission = await state();
    expect(afterAdmission.challenges).toEqual(before.challenges);
    expect(afterAdmission.deliveries).toHaveLength(2);
    expect(await rateState(verificationPolicies)).toEqual(verificationBefore);
    for (const row of await rateState(deliveryPolicies)) {
      const previous = deliveryBefore.find(
        (candidate) => candidate.key === row.key,
      )!;
      const settings =
        row.policyId === policies.deliveryIdentity.id
          ? rates.deliveryIdentity
          : rates.deliveryIp;
      expect(fromGcraPersistenceData(row)).toEqual(
        chargeGcra(
          fromGcraPersistenceData(previous),
          settings,
          admission.admissionNowMicros,
        ),
      );
    }
    const boundaries = await transaction((tx) =>
      cooldown.readAliases(tx, [
        ...keys(policies.identityDeliveryCooldown),
        ...keys(policies.challengeDeliveryCooldown, first.challenge.id),
      ]),
    );
    for (const row of boundaries)
      expect(BigInt(row.windowEndAtMicros!)).toBe(
        admission.admissionNowMicros + 60_000_000n,
      );
    await process(admission.deliveryId);
    expect(provider.submit).toHaveBeenCalledTimes(2);
    const firstContent = provider.submit.mock.calls[0][0].content,
      secondContent = provider.submit.mock.calls[1][0].content;
    const link = module
      .get(AuthenticationMagicLinkService)
      .buildVerificationUrl({
        challengeId: first.challenge.id,
        linkToken: first.proof.linkToken,
      });
    expect(secondContent.text).toContain(first.proof.otp);
    expect(secondContent.text).toContain(link);
    expect(secondContent).toEqual(firstContent);
    const afterSend = await state();
    expect(afterSend.challenges).toEqual(before.challenges);
    expect(afterSend.cd).toEqual(afterAdmission.cd);
    expect(afterSend.gcra).toEqual(afterAdmission.gcra);
    expect(afterSend.receipts).toEqual(afterAdmission.receipts);
    expect(
      await verify(first.challenge, first.proof.linkToken, true),
    ).toMatchObject({ status: 'RATE_LIMITED' });
    expect(await state()).toEqual(afterSend);
    expect(
      await operations.execute(response.operationId, request),
    ).toMatchObject({ replayed: true, result: response.result });
    expect(await state()).toEqual(afterSend);
  });

  it.each(['cooldown', 'window', 'deliveryBudget'] as const)(
    'still enforces its own %s on a genuinely new resend while verification is denied',
    async (reason) => {
      const first = await initial();
      await process(created(first.response).deliveryId);
      await exhaustVerification(first.challenge, first.proof.otp);
      if (reason !== 'cooldown') await allowCooldown(first.challenge.id);
      if (reason === 'window')
        await prisma.authenticationChallenge.update({
          where: { id: first.challenge.id },
          data: {
            expiresAt: new Date(
              Date.now() +
                (module.get(AuthenticationDeliveryPolicyService)
                  .minValidityRemainingSeconds -
                  1) *
                  1000,
            ),
          },
        });
      if (reason === 'deliveryBudget')
        await seedBoundary(
          'deliveryIdentity',
          (await gcra.operationNowMicros(prisma)) + 60_000_000n,
        );
      const before = await state(),
        response = await execute(resend(first.challenge));
      expect(response.result).toMatchObject({
        outcome: 'DENIED',
        denial: reason === 'window' ? 'DELIVERY_WINDOW_CLOSED' : 'RATE_LIMITED',
      });
      if (response.result.outcome === 'DENIED' && reason === 'deliveryBudget')
        expect(response.result.deniedPolicyIds).toContain(
          policies.deliveryIdentity.id,
        );
      expectSameDomain(before, await state());
    },
  );

  it.each([false, true])(
    'retains identity/IP verification debt when real request admission replaces an expired challenge (cleanup=%s)',
    async (cleaned) => {
      const first = await initial();
      await process(created(first.response).deliveryId);
      await exhaustVerification(first.challenge, first.proof.otp);
      await allowCooldown(first.challenge.id);
      // Explicit historical lifecycle fixture. No rate state is rewritten.
      await prisma.authenticationChallenge.update({
        where: { id: first.challenge.id },
        data: {
          expiresAt: new Date(Date.now() - 2000),
          ...(cleaned
            ? { retentionExpiresAt: new Date(Date.now() - 1000) }
            : {}),
        },
      });
      const verificationBefore = await rateState(verificationPolicies);
      if (cleaned) {
        await cleanup.clearOneExpiredEnvelopeBatch(100);
        await cleanup.deleteOneRetainedChallengeBatch(100);
      }
      const oldState = await prisma.authenticationChallenge.findUnique({
        where: { id: first.challenge.id },
      });
      const replacement = created(await execute(signIn()));
      expect(replacement.challengeId).not.toBe(first.challenge.id);
      expect(replacement.deliveryOrigin).toBe('INITIAL');
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: replacement.challengeId },
        }),
        proof = recover(challenge);
      expect(proof.linkToken).not.toBe(first.proof.linkToken);
      expect(challenge.failedAttemptCount).toBe(0);
      expect(challenge.lockedAt).toBeNull();
      expect(await rateState(verificationPolicies)).toEqual(verificationBefore);
      expect(await verify(challenge, proof.otp)).toMatchObject({
        status: 'RATE_LIMITED',
      });
      expect(await rateState(verificationPolicies)).toEqual(verificationBefore);
      expect(
        await prisma.authenticationChallenge.findUnique({
          where: { id: first.challenge.id },
        }),
      ).toEqual(oldState);
      const beforeReplay = await state();
      expect(
        await operations.execute(first.response.operationId, first.request),
      ).toMatchObject({ replayed: true, result: first.response.result });
      expect(await state()).toEqual(beforeReplay);
    },
  );

  it('keeps a long-term verification restriction independent of recovered short-term capacity and new Delivery admission', async () => {
    const first = await initial();
    await process(created(first.response).deliveryId);
    await exhaustVerification(first.challenge, first.proof.otp);
    await allowCooldown(first.challenge.id);
    const now = await gcra.operationNowMicros(prisma);
    // Valid historical bucket fixtures isolate partial recovery; this is not a
    // sustained-load/time measurement. Long-term state remains unchanged below.
    await seedBoundary('verificationIdentityShortTerm', now - 1_000_000n);
    await seedBoundary('verificationIpShortTerm', now - 1_000_000n);
    await seedBoundary('verificationIdentityLongTerm', now + 120_000_000n);
    const before = await rateState(verificationPolicies);
    for (const row of before.filter((row) => row.policyId.endsWith('_SHORT')))
      expect(
        evaluateGcra(
          fromGcraPersistenceData(row),
          row.policyId === policies.verificationIdentityShortTerm.id
            ? rates.verificationIdentityShortTerm
            : rates.verificationIpShortTerm,
          now,
        ).allowed,
      ).toBe(true);
    expect(await verify(first.challenge, first.proof.otp)).toMatchObject({
      status: 'RATE_LIMITED',
      deniedPolicyIds: [policies.verificationIdentityLongTerm.id],
    });
    expect((await execute(signIn())).result.outcome).toBe('REUSED');
    expect(created(await execute(resend(first.challenge))).deliveryOrigin).toBe(
      'RESEND',
    );
    expect(await rateState(verificationPolicies)).toEqual(before);
  });

  it.each([
    'denial',
    'mismatch',
    'malformed',
    'technical',
    'ownerRollback',
    'success',
  ] as const)(
    'preserves independently committed request accounting and Delivery state on verification %s',
    async (outcome) => {
      const first = await initial();
      if (outcome === 'denial')
        await exhaustVerification(first.challenge, first.proof.otp);
      if (outcome === 'technical') {
        await seedBoundary(
          'verificationIdentityLongTerm',
          (await gcra.operationNowMicros(prisma)) + 60_000_000n,
        );
        await prisma.gcraRateLimit.updateMany({
          where: { key: { in: keys(policies.verificationIdentityLongTerm) } },
          data: { policyId: 'INVALID_POLICY_FIXTURE' },
        });
      }
      // This is the real request-accounting service in its own committed owner,
      // not HTTP endpoint wiring and not a limiter call in the proof transaction.
      const admitted = await requestAdmission.consume({
        policy: PUBLIC_PASSWORDLESS_REQUEST_POLICY,
        settings: requestConfig.publicPasswordless,
        characteristic: ipAddress,
      });
      expect(admitted.allowed).toBe(true);
      const requestBefore = await rateState([
        PUBLIC_PASSWORDLESS_REQUEST_POLICY,
      ]);
      for (const row of requestBefore)
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(
            null,
            requestConfig.publicPasswordless,
            admitted.operationNowMicros,
          ),
        );
      const before = await state();
      const wrong = first.proof.otp === '999999' ? '999998' : '999999';
      if (outcome === 'technical')
        await expect(
          verify(first.challenge, first.proof.otp),
        ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      else if (outcome === 'ownerRollback')
        await expect(
          transaction(async (tx) => {
            expect(
              (
                await verifier.verifyAndConsumeOtpInTransaction(tx, {
                  challengeId: first.challenge.id,
                  expectedPurpose: 'SIGN_IN',
                  expectedBoundSessionId: null,
                  ipAddress,
                  proof: wrong,
                })
              ).status,
            ).toBe('INVALID_PROOF');
            throw new Error('Owner rollback fixture.');
          }),
        ).rejects.toThrow('Owner rollback fixture.');
      else
        expect(
          await verify(
            first.challenge,
            outcome === 'malformed'
              ? '0'
              : outcome === 'mismatch'
                ? wrong
                : first.proof.otp,
          ),
        ).toMatchObject({
          status:
            outcome === 'denial'
              ? 'RATE_LIMITED'
              : outcome === 'success'
                ? 'VERIFIED'
                : 'INVALID_PROOF',
        });
      const after = await state();
      expect(await rateState([PUBLIC_PASSWORDLESS_REQUEST_POLICY])).toEqual(
        requestBefore,
      );
      expect(after.deliveries).toEqual(before.deliveries);
      expect(after.cd).toEqual(before.cd);
      expect(after.receipts).toEqual(before.receipts);
      if (
        ['technical', 'ownerRollback', 'denial', 'malformed'].includes(outcome)
      )
        expect(after).toEqual(before);
      if (outcome === 'success') {
        expect(after.gcra).toEqual(before.gcra);
        expect(after.challenges[0].consumedAt).not.toBeNull();
      }
      if (outcome === 'mismatch') {
        expect(after.challenges[0]).toMatchObject({
          failedAttemptCount: 1,
          consumedAt: null,
          lockedAt: null,
          encryptedProof: before.challenges[0].encryptedProof,
        });
        expect(
          new Set(
            (await rateState(verificationPolicies)).map((row) => row.policyId),
          ).size,
        ).toBe(4);
      }
    },
  );
  function deferred() {
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  async function waitForLock(applicationName: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE application_name=${applicationName} AND wait_event_type='Lock'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected a real PostgreSQL lock wait.');
  }
  async function serialize<A, B>(
    first: (tx: Prisma.TransactionClient) => Promise<A>,
    second: (tx: Prisma.TransactionClient) => Promise<B>,
  ) {
    const ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      const result = await first(tx);
      ready.resolve();
      await release.promise;
      return result;
    });
    void holding.catch(ready.reject);
    let pending: Promise<B> | undefined;
    try {
      await ready.promise;
      pending = transaction(second, replica);
      // Observe the contender waiting before allowing the first owner to commit.
      await waitForLock(replicaName);
      release.resolve();
      return await Promise.all([holding, pending]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending ? [holding, pending] : [holding]);
    }
  }
  function verificationInput(
    challenge: AuthenticationChallenge,
    proof: string,
  ) {
    return {
      challengeId: challenge.id,
      expectedPurpose: challenge.purpose,
      expectedBoundSessionId: challenge.boundSessionId,
      ipAddress,
      proof,
    };
  }
  function resendAdmissionInput(challenge: AuthenticationChallenge) {
    return {
      challengeId: challenge.id,
      ipAddress,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
      retentionExpiresAt: challenge.retentionExpiresAt,
    };
  }

  it.each([
    ['verify', 'MATCH'],
    ['resend', 'MATCH'],
    ['verify', 'MISMATCH'],
    ['resend', 'MISMATCH'],
  ] as const)(
    'serializes %s first against concurrent resend/verification (%s)',
    async (firstOwner, proofOutcome) => {
      const first = await initial();
      await process(created(first.response).deliveryId);
      await allowCooldown(first.challenge.id);
      const before = await state();
      const candidate =
        proofOutcome === 'MATCH'
          ? first.proof.otp
          : first.proof.otp === '999999'
            ? '999998'
            : '999999';
      const verifyWork = (tx: Prisma.TransactionClient) =>
        verifier.verifyAndConsumeOtpInTransaction(
          tx,
          verificationInput(first.challenge, candidate),
        );
      const resendWork = (tx: Prisma.TransactionClient) =>
        resendAdmission.admitResendInTransaction(
          tx,
          resendAdmissionInput(first.challenge),
        );
      const result =
        firstOwner === 'verify'
          ? await serialize(verifyWork, resendWork).then(
              ([verification, resend]) => ({ verification, resend }),
            )
          : await serialize(resendWork, verifyWork).then(
              ([resend, verification]) => ({ verification, resend }),
            );
      expect(result.verification.status).toBe(
        proofOutcome === 'MATCH' ? 'VERIFIED' : 'INVALID_PROOF',
      );
      const after = await state(),
        challenge = after.challenges[0];
      expect(challenge.expiresAt).toEqual(first.challenge.expiresAt);
      expect(challenge.lockedAt).toBeNull();
      expect(after.receipts).toEqual(before.receipts);
      if (proofOutcome === 'MATCH') {
        expect(challenge.consumedAt).not.toBeNull();
        expect(challenge.encryptedProof).toBeNull();
        expect(challenge.failedAttemptCount).toBe(0);
        expect(await rateState(verificationPolicies)).toEqual([]);
      } else {
        expect(challenge.consumedAt).toBeNull();
        expect(challenge.failedAttemptCount).toBe(1);
        expect(recover(challenge)).toEqual(first.proof);
      }
      if (firstOwner === 'verify' && proofOutcome === 'MATCH') {
        expect(result.resend).toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
        expect(after.deliveries).toEqual(before.deliveries);
        expect(after.cd).toEqual(before.cd);
        expect(after.gcra).toEqual(before.gcra);
      } else {
        if (result.resend.outcome !== 'CREATED')
          throw new Error('Expected concurrent resend creation.');
        const resendResult = result.resend;
        expect(after.deliveries).toHaveLength(2);
        for (const row of await rateState(deliveryPolicies)) {
          const previous = before.gcra.find(
            (candidate) => candidate.key === row.key,
          )!;
          const settings =
            row.policyId === policies.deliveryIdentity.id
              ? rates.deliveryIdentity
              : rates.deliveryIp;
          expect(fromGcraPersistenceData(row)).toEqual(
            chargeGcra(
              fromGcraPersistenceData(previous),
              settings,
              resendResult.operationNowMicros,
            ),
          );
        }
        const claim = await deliveries.claimNextDelivery();
        expect(claim?.id).toBe(resendResult.delivery.id);
        expect(await worker.process(claim!)).toEqual({
          outcome: proofOutcome === 'MATCH' ? 'CANCELLED' : 'SENT',
        });
        expect(provider.submit).toHaveBeenCalledTimes(
          proofOutcome === 'MATCH' ? 1 : 2,
        );
      }
    },
  );

  it.each(['verify', 'replacement'] as const)(
    'serializes %s first for verification of an expired challenge and request-driven replacement',
    async (firstOwner) => {
      const first = await initial();
      await process(created(first.response).deliveryId);
      await allowCooldown(first.challenge.id);
      const wrong = first.proof.otp === '999999' ? '999998' : '999999';
      await verify(first.challenge, wrong);
      // Explicit historical expiry fixture; verification debt is preserved.
      await prisma.authenticationChallenge.update({
        where: { id: first.challenge.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const verificationBefore = await rateState(verificationPolicies);
      const verifyWork = (tx: Prisma.TransactionClient) =>
        verifier.verifyAndConsumeOtpInTransaction(
          tx,
          verificationInput(first.challenge, first.proof.otp),
        );
      const requestWork = (tx: Prisma.TransactionClient) =>
        requests.requestSignInInTransaction(tx, {
          normalizedIdentity: identity,
          ipAddress,
          idempotencyKey: randomUUID(),
          templateProtocolVersion: 1,
        });
      const result =
        firstOwner === 'verify'
          ? await serialize(verifyWork, requestWork).then(
              ([verification, replacement]) => ({ verification, replacement }),
            )
          : await serialize(requestWork, verifyWork).then(
              ([replacement, verification]) => ({ verification, replacement }),
            );
      expect(result.verification).toEqual({
        status: 'UNAVAILABLE',
        internalReason: 'EXPIRED',
      });
      if (result.replacement.outcome !== 'CREATED')
        throw new Error('Expected replacement admission.');
      const id = result.replacement.challenge.id;
      challengeIds.add(id);
      keys(policies.challengeDeliveryCooldown, id);
      expect(id).not.toBe(first.challenge.id);
      const replacement =
        await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id },
        });
      expect(replacement).toMatchObject({
        consumedAt: null,
        lockedAt: null,
        failedAttemptCount: 0,
      });
      expect(recover(replacement).linkToken).not.toBe(first.proof.linkToken);
      const old = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: first.challenge.id },
      });
      expect(old.encryptedProof).toBeNull();
      expect(old.consumedAt).toBeNull();
      expect(old.failedAttemptCount).toBe(1);
      expect(await rateState(verificationPolicies)).toEqual(verificationBefore);
      expect(await verify(replacement, recover(replacement).otp)).toMatchObject(
        { status: 'VERIFIED' },
      );
      expect(await rateState(verificationPolicies)).toEqual(verificationBefore);
    },
  );

  it('lets cleanup skip a challenge locked by verification, then deletes it after commit without refunding debt', async () => {
    const first = await initial();
    await process(created(first.response).deliveryId);
    await verify(
      first.challenge,
      first.proof.otp === '999999' ? '999998' : '999999',
    );
    await prisma.authenticationChallenge.update({
      where: { id: first.challenge.id },
      data: {
        expiresAt: new Date(Date.now() - 2000),
        retentionExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const debt = await rateState(verificationPolicies),
      ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      const result = await verifier.verifyAndConsumeOtpInTransaction(
        tx,
        verificationInput(first.challenge, first.proof.otp),
      );
      ready.resolve();
      await release.promise;
      return result;
    });
    void holding.catch(ready.reject);
    try {
      await ready.promise;
      expect(await replicaCleanup.clearOneExpiredEnvelopeBatch(100)).toBe(0);
      expect(await replicaCleanup.deleteOneRetainedChallengeBatch(100)).toBe(0);
      expect(
        await prisma.authenticationChallenge.findUnique({
          where: { id: first.challenge.id },
        }),
      ).not.toBeNull();
      release.resolve();
      expect(await holding).toEqual({
        status: 'UNAVAILABLE',
        internalReason: 'EXPIRED',
      });
      expect(await replicaCleanup.deleteOneRetainedChallengeBatch(100)).toBe(1);
      expect(await rateState(verificationPolicies)).toEqual(debt);
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
    }
  });

  it('waits for real retention cleanup that owns the row first, then rejects the removed challenge without charging', async () => {
    const first = await initial();
    await process(created(first.response).deliveryId);
    await verify(
      first.challenge,
      first.proof.otp === '999999' ? '999998' : '999999',
    );
    await prisma.authenticationChallenge.update({
      where: { id: first.challenge.id },
      data: {
        expiresAt: new Date(Date.now() - 2000),
        retentionExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const debt = await rateState(verificationPolicies),
      schema = `verification_cleanup_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    const lockId = BigInt.asIntN(
      64,
      BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 16)),
    );
    const ready = deferred(),
      release = deferred();
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    let holding: Promise<void> | undefined,
      pendingCleanup: Promise<number> | undefined,
      pendingProof: ReturnType<typeof verify> | undefined;
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".hold_delete() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF OLD."id"=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint); END IF; RETURN OLD; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE DELETE ON "AuthenticationChallenge" FOR EACH ROW EXECUTE FUNCTION "${schema}".hold_delete('${first.challenge.id}','${lockId.toString()}')`,
      );
      holding = transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
        ready.resolve();
        await release.promise;
      });
      void holding.catch(ready.reject);
      await ready.promise;
      pendingCleanup = replicaCleanup.deleteOneRetainedChallengeBatch(100);
      await waitForLock(replicaName);
      pendingProof = verify(first.challenge, first.proof.otp);
      await waitForLock(primaryName);
      release.resolve();
      await holding;
      expect(await pendingCleanup).toBe(1);
      expect(await pendingProof).toEqual({
        status: 'UNAVAILABLE',
        internalReason: 'NOT_FOUND',
      });
      expect(await rateState(verificationPolicies)).toEqual(debt);
    } finally {
      release.resolve();
      await Promise.allSettled(
        [holding, pendingCleanup, pendingProof].filter(
          (value) => value !== undefined,
        ),
      );
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationChallenge"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it.each(['40001', '40P01'] as const)(
    'retries integrated verification only in a new owner after confirmed SQLSTATE %s, with one final diagnostic and four charges',
    async (sqlState) => {
      const first = await initial(),
        before = await state();
      const key = keys(policies.verificationIpShortTerm).sort().at(-1)!;
      if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
        throw new Error('Unexpected fixture key.');
      const schema = `verification_owner_abort_${randomUUID().replaceAll('-', '')}`,
        trigger = `${schema}_trigger`,
        marker = `verification-retry:${randomUUID()}`;
      ownerSubjects.add(marker);
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      try {
        await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION "${schema}".abort_once() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."key"=TG_ARGV[0] AND nextval('"${schema}".attempts')=1 THEN RAISE EXCEPTION 'Injected confirmed abort.' USING ERRCODE='${sqlState}'; END IF; RETURN NEW; END $test$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".abort_once('${key}')`,
        );
        let attempts = 0,
          committed:
            | {
                result: Awaited<ReturnType<typeof verify>>;
                lower: bigint;
                upper: bigint;
              }
            | undefined;
        while (attempts < 2) {
          attempts++;
          try {
            committed = await transaction(
              async (tx) => {
                await tx.authenticationChallengeSubject.create({
                  data: { key: marker },
                });
                const lower = await gcra.operationNowMicros(tx);
                const result = await verifier.verifyAndConsumeOtpInTransaction(
                  tx,
                  verificationInput(
                    first.challenge,
                    first.proof.otp === '999999' ? '999998' : '999999',
                  ),
                );
                return {
                  result,
                  lower,
                  upper: await gcra.operationNowMicros(tx),
                };
              },
              attempts === 1 ? prisma : replica,
            );
            break;
          } catch (error) {
            expect(isRetryableGcraTransactionError(error)).toBe(true);
            if (!isRetryableGcraTransactionError(error) || attempts === 2)
              throw error;
            expect(await state()).toEqual(before);
            expect(
              await prisma.authenticationChallengeSubject.findUnique({
                where: { key: marker },
              }),
            ).toBeNull();
          }
        }
        expect(attempts).toBe(2);
        if (!committed) throw new Error('Expected committed retry.');
        expect(committed.result).toMatchObject({
          status: 'INVALID_PROOF',
          kind: 'MISMATCH',
          failedAttemptCount: 1,
          locked: false,
        });
        const rows = await rateState(verificationPolicies),
          firstRow = fromGcraPersistenceData(rows[0]);
        const inferredNow =
          (firstRow.tat.numerator * BigInt(firstRow.policy.rate) -
            BigInt(firstRow.policy.periodSeconds) *
              1_000_000n *
              firstRow.tat.denominator) /
          (firstRow.tat.denominator * BigInt(firstRow.policy.rate));
        expect(inferredNow).toBeGreaterThanOrEqual(committed.lower);
        expect(inferredNow).toBeLessThanOrEqual(committed.upper);
        expect(new Set(rows.map((row) => row.policyId)).size).toBe(4);
        for (const row of rows) {
          const state = fromGcraPersistenceData(row);
          expect(state).toEqual(chargeGcra(null, state.policy, inferredNow));
        }
        const after = await state();
        expect(after.deliveries).toEqual(before.deliveries);
        expect(after.cd).toEqual(before.cd);
        expect(after.receipts).toEqual(before.receipts);
        expect(recover(after.challenges[0])).toEqual(first.proof);
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
        );
        await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }
    },
  );

  it('does not blindly retry an unconfirmed acknowledgement failure after a committed verification', async () => {
    const first = await initial();
    let attempts = 0;
    // Simulates caller acknowledgement loss after commit, not a network fault.
    async function owner() {
      for (let attempt = 0; attempt < 2; attempt++) {
        attempts++;
        try {
          await verify(
            first.challenge,
            first.proof.otp === '999999' ? '999998' : '999999',
          );
          throw new Error('Unconfirmed commit acknowledgement.');
        } catch (error) {
          if (isRetryableGcraTransactionError(error) && attempt === 0) continue;
          throw error;
        }
      }
    }
    await expect(owner()).rejects.toThrow(
      'Unconfirmed commit acknowledgement.',
    );
    expect(attempts).toBe(1);
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: first.challenge.id },
    });
    expect(challenge.failedAttemptCount).toBe(1);
    expect(challenge.lockedAt).toBeNull();
    expect(recover(challenge)).toEqual(first.proof);
    expect(
      new Set(
        (await rateState(verificationPolicies)).map((row) => row.policyId),
      ).size,
    ).toBe(4);
  });
  it('serializes the shared IP budget across 90 identities using actual admission-time bounds without assuming a frozen clock', async () => {
    const fixtures: {
      challenge: AuthenticationChallenge;
      proof: ReturnType<typeof recover>;
    }[] = [];
    for (let index = 0; index < 91; index++) {
      const email = `shared-ip-${randomUUID()}@example.edu`;
      identities.add(email);
      for (const policy of [
        ...verificationPolicies,
        ...deliveryPolicies,
        policies.identityDeliveryCooldown,
      ]) {
        for (const bucket of derivation.deriveKeys(
          policy,
          policy.characteristicKind === 'IDENTITY' ? email : ipAddress,
        ).buckets)
          ownedKeys.add(bucket.key);
      }
      const admission = created(
        await execute({
          kind: 'SIGN_IN_REQUEST',
          input: {
            normalizedIdentity: email,
            ipAddress,
            templateProtocolVersion: 1,
          },
        }),
      );
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: admission.challengeId },
      });
      fixtures.push({ challenge, proof: recover(challenge) });
    }
    const shortKey = keys(policies.verificationIpShortTerm)[0],
      longKey = keys(policies.verificationIpLongTerm)[0];
    for (const key of [shortKey, longKey])
      if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
        throw new Error('Unexpected fixture key.');
    const schema = `verification_ip_audit_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      // Transactional test-only observation of committed writes. The diagnostic
      // timestamp is the verifier's real admission time truncated to milliseconds.
      // No repository, limiter, clock or crypto service is intercepted/replaced.
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${schema}".charges (seq bigserial PRIMARY KEY, "challengeId" text NOT NULL, "policyId" text NOT NULL, numerator numeric NOT NULL, denominator numeric NOT NULL, "operationMicros" numeric NOT NULL)`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".observe_charge() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."key"=TG_ARGV[0] OR NEW."key"=TG_ARGV[1] THEN INSERT INTO "${schema}".charges ("challengeId","policyId",numerator,denominator,"operationMicros") SELECT "id",NEW."policyId",NEW."tatNumerator",NEW."tatDenominator",trunc(EXTRACT(EPOCH FROM "updatedAt")*1000000) FROM "AuthenticationChallenge" WHERE "id"=current_setting('unicon_test.challenge_id',true); END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" AFTER INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".observe_charge('${shortKey}','${longKey}')`,
      );
      const contenders = fixtures.slice(0, 90);
      const results = await Promise.all(
        contenders.map(({ challenge, proof }, index) =>
          transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('unicon_test.challenge_id',${challenge.id},true)`;
              return index % 2
                ? verifier.verifyAndConsumeMagicLinkInTransaction(
                    tx,
                    verificationInput(
                      challenge,
                      Buffer.from(
                        Buffer.from(proof.linkToken, 'base64url').map(
                          (byte) => byte ^ 1,
                        ),
                      ).toString('base64url'),
                    ),
                  )
                : verifier.verifyAndConsumeOtpInTransaction(
                    tx,
                    verificationInput(
                      challenge,
                      proof.otp === '999999' ? '999998' : '999999',
                    ),
                  );
            },
            index % 2 ? replica : prisma,
          ),
        ),
      );
      const accepted = results.filter(
        (result) => result.status === 'INVALID_PROOF',
      );
      // At least the idle burst fits. Additional capacity may replenish while
      // the real DB processes the batch; exact 72-at-once math is covered separately.
      expect(accepted.length).toBeGreaterThanOrEqual(
        rates.verificationIpShortTerm.burst,
      );
      expect(
        results.every(
          (result) =>
            result.status === 'INVALID_PROOF' ||
            result.status === 'RATE_LIMITED',
        ),
      ).toBe(true);
      type Audit = {
        challengeId: string;
        policyId: string;
        numerator: string;
        denominator: string;
        operationMicros: string;
      };
      const audit = await prisma.$queryRawUnsafe<Audit[]>(
        `SELECT "challengeId","policyId",numerator::text,denominator::text,"operationMicros"::text FROM "${schema}".charges ORDER BY seq`,
      );
      expect(audit).toHaveLength(accepted.length * 2);
      const previous = new Map<string, GcraState>();
      const compare = (left: GcraTime, right: GcraTime) =>
        left.numerator * right.denominator - right.numerator * left.denominator;
      for (const row of audit) {
        const policy =
          row.policyId === policies.verificationIpShortTerm.id
            ? rates.verificationIpShortTerm
            : rates.verificationIpLongTerm;
        const before = previous.get(row.policyId) ?? null,
          lower = BigInt(row.operationMicros),
          upper = lower + 999n;
        // Every accepted charge must have been eligible at a real instant in
        // the diagnostic timestamp's exact one-millisecond interval.
        const evaluation = evaluateGcra(before, policy, upper);
        expect(evaluation.allowed).toBe(true);
        const boundary =
          (evaluation.eligibleAt.numerator +
            evaluation.eligibleAt.denominator -
            1n) /
          evaluation.eligibleAt.denominator;
        const earliest = boundary > lower ? boundary : lower;
        const observed = createGcraState(
          {
            numerator: BigInt(row.numerator),
            denominator: BigInt(row.denominator),
          },
          policy,
        );
        expect(
          compare(observed.tat, chargeGcra(before, policy, earliest).tat),
        ).toBeGreaterThanOrEqual(0n);
        expect(
          compare(observed.tat, chargeGcra(before, policy, upper).tat),
        ).toBeLessThanOrEqual(0n);
        previous.set(row.policyId, observed);
      }
      for (const row of await rateState([
        policies.verificationIpShortTerm,
        policies.verificationIpLongTerm,
      ]))
        expect(fromGcraPersistenceData(row)).toEqual(
          previous.get(row.policyId),
        );
      for (let index = 0; index < contenders.length; index++) {
        const { challenge, proof } = contenders[index],
          result = results[index];
        const current = await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: challenge.id },
        });
        const identityKeys = [
          policies.verificationIdentityShortTerm,
          policies.verificationIdentityLongTerm,
        ].flatMap((policy) =>
          derivation
            .deriveKeys(policy, challenge.normalizedIdentity)
            .buckets.map((bucket) => bucket.key),
        );
        const identityRows = await prisma.gcraRateLimit.findMany({
          where: { key: { in: identityKeys } },
        });
        expect(current.consumedAt).toBeNull();
        expect(current.lockedAt).toBeNull();
        expect(recover(current)).toEqual(proof);
        if (result.status === 'INVALID_PROOF') {
          expect(current.failedAttemptCount).toBe(1);
          expect(identityRows).toHaveLength(identityKeys.length);
          expect(
            audit.filter((row) => row.challengeId === challenge.id),
          ).toHaveLength(2);
        } else {
          expect(result).toMatchObject({
            status: 'RATE_LIMITED',
            deniedPolicyIds: [policies.verificationIpShortTerm.id],
          });
          expect(current.failedAttemptCount).toBe(0);
          expect(identityRows).toEqual([]);
          expect(
            audit.filter((row) => row.challengeId === challenge.id),
          ).toEqual([]);
        }
      }
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER "${trigger}" ON "GcraRateLimit"`,
      );
      // A future boundary fixture guarantees a denial independently of machine
      // speed. It does not replace the real concurrent charging checks above.
      await seedBoundary(
        'verificationIpShortTerm',
        (await gcra.operationNowMicros(prisma)) + 30_000_000n,
      );
      const debt = await rateState([
          policies.verificationIpShortTerm,
          policies.verificationIpLongTerm,
        ]),
        reserved = fixtures[90];
      expect(
        await verify(reserved.challenge, reserved.proof.otp),
      ).toMatchObject({
        status: 'RATE_LIMITED',
        deniedPolicyIds: [policies.verificationIpShortTerm.id],
      });
      expect(
        await rateState([
          policies.verificationIpShortTerm,
          policies.verificationIpLongTerm,
        ]),
      ).toEqual(debt);
      expect(
        (
          await prisma.authenticationChallenge.findUniqueOrThrow({
            where: { id: reserved.challenge.id },
          })
        ).failedAttemptCount,
      ).toBe(0);
      const reservedKeys = [
        policies.verificationIdentityShortTerm,
        policies.verificationIdentityLongTerm,
      ].flatMap((policy) =>
        derivation
          .deriveKeys(policy, reserved.challenge.normalizedIdentity)
          .buckets.map((bucket) => bucket.key),
      );
      expect(
        await prisma.gcraRateLimit.findMany({
          where: { key: { in: reservedKeys } },
        }),
      ).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
