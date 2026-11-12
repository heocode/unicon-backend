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
import { AuthenticationChallengeVerificationService } from '../src/auth/challenge/services/authentication-challenge-verification.service';
import { AuthenticationEmailProviderPort } from '../src/auth/delivery/ports/authentication-email-provider.port';
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
  let module: TestingModule, prisma: PrismaService;
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
      where: { normalizedIdentity: identity },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { normalizedIdentity: identity },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    challengeIds.clear();
    operationIds.clear();
    ownedKeys.clear();
    provider.submit.mockReset();
  });
  afterAll(async () => {
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
  function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout','5s',true)`;
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
});
