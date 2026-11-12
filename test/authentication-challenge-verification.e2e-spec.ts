import { ConfigService } from '@nestjs/config';
import { TestingModule, Test } from '@nestjs/testing';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Prisma } from '../src/generated/prisma/client';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { createGcraState } from '../src/rate-limit/utils/gcra-state.util';

import { AppModule } from '../src/app.module';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationChallengeVerificationService } from '../src/auth/challenge/services/authentication-challenge-verification.service';
import {
  ChallengeVerificationStatus,
  InternalChallengeUnavailabilityReason,
  InvalidChallengeProofKind,
  type AuthenticationChallengeVerificationResult,
} from '../src/auth/challenge/types/authentication-challenge-verification.type';
import type {
  ChallengeProofContext,
  TransientChallengeDeliveryProof,
} from '../src/auth/challenge/types/challenge-proof.type';
import {
  AuthenticationChallengePurpose,
  AuthenticationIdentityType,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Authentication challenge verification (e2e)', () => {
  jest.setTimeout(20_000);
  const ownedKeys = new Set<string>();
  const addresses = new Map<string, string>();
  let replica: PrismaService;
  let buckets: RateLimitBucketKeyService;
  let rates: AuthenticationRateLimitConfigService;
  let rateRepository: GcraAdmissionRepository;
  const replicaName = `verification_owner_${randomUUID().replaceAll('-', '')}`;
  const subjectPrefix = 'e2e:challenge-verification:';

  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let proofFactory: AuthenticationChallengeProofFactoryService;
  let verificationService: AuthenticationChallengeVerificationService;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    const url = new URL(
      moduleFixture.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Dedicated test database required.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    buckets = moduleFixture.get(RateLimitBucketKeyService);
    rates = moduleFixture.get(AuthenticationRateLimitConfigService);
    rateRepository = moduleFixture.get(GcraAdmissionRepository);
    proofFactory = moduleFixture.get(
      AuthenticationChallengeProofFactoryService,
    );
    verificationService = moduleFixture.get(
      AuthenticationChallengeVerificationService,
    );
  });

  beforeEach(async () => {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: subjectPrefix } },
    });
  });

  afterEach(async () => {
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    ownedKeys.clear();
    addresses.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: subjectPrefix } },
    });
    await moduleFixture.close();
  });

  async function createChallenge(options?: {
    expiresAt?: Date;
    failedAttemptCount?: number;
    normalizedIdentity?: string;
    ipAddress?: string;
    locked?: boolean;
  }): Promise<{
    context: ChallengeProofContext;
    proof: TransientChallengeDeliveryProof;
  }> {
    const id = randomUUID();
    const context: ChallengeProofContext = {
      challengeId: id,
      purpose: AuthenticationChallengePurpose.SIGN_IN,
      normalizedIdentity:
        options?.normalizedIdentity ?? `student-${id}@example.edu`,
    };
    addresses.set(
      id,
      options?.ipAddress ??
        `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
    );
    keys(context);
    const generated = proofFactory.generate(context);
    const subjectKey = `${subjectPrefix}${id}`;

    await prisma.authenticationChallengeSubject.create({
      data: {
        key: subjectKey,
        challenges: {
          create: {
            id,
            identityType: AuthenticationIdentityType.INSTITUTIONAL_EMAIL,
            normalizedIdentity: context.normalizedIdentity,
            purpose: context.purpose,
            otpHash: Uint8Array.from(generated.persistence.hashing.otpHash),
            linkTokenHash: Uint8Array.from(
              generated.persistence.hashing.linkTokenHash,
            ),
            hashProtocolVersion:
              generated.persistence.hashing.hashProtocolVersion,
            hashKeyVersion: generated.persistence.hashing.hashKeyVersion,
            encryptedProof: Uint8Array.from(
              generated.persistence.encryption.encryptedProof,
            ),
            proofEncryptionIv: Uint8Array.from(
              generated.persistence.encryption.proofEncryptionIv,
            ),
            proofEncryptionTag: Uint8Array.from(
              generated.persistence.encryption.proofEncryptionTag,
            ),
            encryptionProtocolVersion:
              generated.persistence.encryption.encryptionProtocolVersion,
            encryptionKeyVersion:
              generated.persistence.encryption.encryptionKeyVersion,
            expiresAt:
              options?.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
            failedAttemptCount: options?.failedAttemptCount ?? 0,
            ...(options?.locked
              ? {
                  lockedAt: new Date(),
                  encryptedProof: null,
                  proofEncryptionIv: null,
                  proofEncryptionTag: null,
                }
              : {}),
            retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      },
    });

    return { context, proof: generated.deliveryProof };
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  function inTransaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    other = false,
  ): Promise<T> {
    return (other ? replica : prisma).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout','5s',true)`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
  function wrongOtp(correct: string) {
    return correct === '999999' ? '999998' : '999999';
  }
  function keys(context: ChallengeProofContext) {
    const result = [
      policies.verificationIdentityShortTerm,
      policies.verificationIdentityLongTerm,
      policies.verificationIpShortTerm,
      policies.verificationIpLongTerm,
    ].flatMap((policy) =>
      buckets
        .deriveKeys(
          policy,
          policy.characteristicKind === 'IDENTITY'
            ? context.normalizedIdentity
            : addresses.get(context.challengeId),
        )
        .buckets.map((bucket) => bucket.key),
    );
    result.forEach((key) => ownedKeys.add(key));
    return result;
  }
  function state(context: ChallengeProofContext) {
    return prisma.gcraRateLimit.findMany({
      where: { key: { in: keys(context) } },
      orderBy: { key: 'asc' },
    });
  }
  function challengeState(context: ChallengeProofContext) {
    return prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
  }
  function verifyInput(context: ChallengeProofContext, proof: string) {
    return {
      challengeId: context.challengeId,
      expectedPurpose: context.purpose,
      expectedBoundSessionId: null,
      ipAddress: addresses.get(context.challengeId),
      proof,
    };
  }

  function verifyOtp(
    context: ChallengeProofContext,
    proof: string,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return inTransaction((transaction) =>
      verificationService.verifyAndConsumeOtpInTransaction(transaction, {
        challengeId: context.challengeId,
        expectedPurpose: context.purpose,
        expectedBoundSessionId: null,
        ipAddress: addresses.get(context.challengeId),
        proof,
      }),
    );
  }

  function verifyLink(
    context: ChallengeProofContext,
    proof: string,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return inTransaction((transaction) =>
      verificationService.verifyAndConsumeMagicLinkInTransaction(transaction, {
        challengeId: context.challengeId,
        expectedPurpose: context.purpose,
        expectedBoundSessionId: null,
        ipAddress: addresses.get(context.challengeId),
        proof,
      }),
    );
  }

  it('does not consume an attempt for malformed OTP', async () => {
    const { context } = await createChallenge();

    await expect(verifyOtp(context, '4201')).resolves.toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MALFORMED,
      attemptConsumed: false,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.failedAttemptCount).toBe(0);
    expect(challenge.lockedAt).toBeNull();
    expect(challenge.encryptedProof).not.toBeNull();
  });

  it('keeps the fifth canonical mismatch live with its stable envelope', async () => {
    const { context, proof } = await createChallenge({ failedAttemptCount: 4 });

    const result = await verifyOtp(context, wrongOtp(proof.otp));
    expect(result).toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MISMATCH,
      attemptConsumed: true,
      failedAttemptCount: 5,
      locked: false,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.failedAttemptCount).toBe(5);
    expect(challenge.lockedAt).toBeNull();
    expect(challenge.encryptedProof).not.toBeNull();
    expect(challenge.proofEncryptionIv).not.toBeNull();
    expect(challenge.proofEncryptionTag).not.toBeNull();
    expect(challenge.hashProtocolVersion).toBe(1);
    expect(challenge.encryptionProtocolVersion).toBe(1);
  });

  it('does not reopen a legacy terminal locked challenge', async () => {
    const { context, proof } = await createChallenge({
      failedAttemptCount: 5,
      locked: true,
    });
    const before = await challengeState(context);
    expect(await verifyOtp(context, proof.otp)).toEqual({
      status: 'UNAVAILABLE',
      internalReason: 'LOCKED',
    });
    expect(await challengeState(context)).toEqual(before);
    expect(await state(context)).toEqual([]);
  });

  it('consumes OTP and makes its magic link a replay', async () => {
    const { context, proof } = await createChallenge();

    const otpResult = await verifyOtp(context, proof.otp);
    expect(otpResult.status).toBe(ChallengeVerificationStatus.VERIFIED);
    await expect(verifyLink(context, proof.linkToken)).resolves.toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.CONSUMED,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.consumedAt).toEqual(
      otpResult.status === ChallengeVerificationStatus.VERIFIED
        ? otpResult.challenge.consumedAt
        : null,
    );
    expect(challenge.encryptedProof).toBeNull();
    expect(challenge.otpHash).toHaveLength(32);
    expect(challenge.linkTokenHash).toHaveLength(32);
  });

  it('consumes a magic link and makes its OTP a replay', async () => {
    const { context, proof } = await createChallenge();

    const linkResult = await verifyLink(context, proof.linkToken);
    expect(linkResult).toMatchObject({
      status: ChallengeVerificationStatus.VERIFIED,
      challenge: { authenticationMethod: 'EMAIL_MAGIC_LINK' },
    });
    await expect(verifyOtp(context, proof.otp)).resolves.toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.CONSUMED,
    });
  });

  it('does not mutate challenge state on purpose mismatch', async () => {
    const { context, proof } = await createChallenge();

    await expect(
      inTransaction((transaction) =>
        verificationService.verifyAndConsumeOtpInTransaction(transaction, {
          challengeId: context.challengeId,
          expectedPurpose: AuthenticationChallengePurpose.STEP_UP,
          expectedBoundSessionId: null,
          ipAddress: addresses.get(context.challengeId),
          proof: proof.otp,
        }),
      ),
    ).resolves.toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.PURPOSE_MISMATCH,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.consumedAt).toBeNull();
    expect(challenge.failedAttemptCount).toBe(0);
    expect(challenge.encryptedProof).not.toBeNull();
  });

  it('serializes concurrent OTP and magic-link consumption', async () => {
    const { context, proof } = await createChallenge();

    const results = await Promise.all([
      verifyOtp(context, proof.otp),
      verifyLink(context, proof.linkToken),
    ]);

    expect(
      results.filter(
        (result) => result.status === ChallengeVerificationStatus.VERIFIED,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === ChallengeVerificationStatus.UNAVAILABLE &&
          result.internalReason ===
            InternalChallengeUnavailabilityReason.CONSUMED,
      ),
    ).toHaveLength(1);
  });

  it('does not lose concurrent canonical OTP failures', async () => {
    const { context, proof } = await createChallenge();

    await Promise.all(
      Array.from({ length: 5 }, () => verifyOtp(context, wrongOtp(proof.otp))),
    );

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.failedAttemptCount).toBe(5);
    expect(challenge.lockedAt).toBeNull();
    expect(challenge.encryptedProof).not.toBeNull();
  });

  it('clears an expired envelope without changing terminal timestamps', async () => {
    const expiresAt = new Date(Date.now() - 1_000);
    const { context, proof } = await createChallenge({ expiresAt });

    await expect(verifyOtp(context, proof.otp)).resolves.toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.EXPIRED,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.expiresAt).toEqual(expiresAt);
    expect(challenge.consumedAt).toBeNull();
    expect(challenge.lockedAt).toBeNull();
    expect(challenge.encryptedProof).toBeNull();
  });

  it('rolls consume back when downstream orchestration fails technically', async () => {
    const { context, proof } = await createChallenge();

    await expect(
      inTransaction(async (transaction) => {
        const result =
          await verificationService.verifyAndConsumeOtpInTransaction(
            transaction,
            {
              challengeId: context.challengeId,
              expectedPurpose: context.purpose,
              expectedBoundSessionId: null,
              ipAddress: addresses.get(context.challengeId),
              proof: proof.otp,
            },
          );
        expect(result.status).toBe(ChallengeVerificationStatus.VERIFIED);
        throw new Error('Simulated downstream database failure.');
      }),
    ).rejects.toThrow('Simulated downstream database failure.');

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.consumedAt).toBeNull();
    expect(challenge.encryptedProof).not.toBeNull();
  });

  it('commits consume when caller returns an explicitly expected outcome', async () => {
    const { context, proof } = await createChallenge();

    const outcome = await inTransaction(async (transaction) => {
      const verification =
        await verificationService.verifyAndConsumeOtpInTransaction(
          transaction,
          {
            challengeId: context.challengeId,
            expectedPurpose: context.purpose,
            expectedBoundSessionId: null,
            ipAddress: addresses.get(context.challengeId),
            proof: proof.otp,
          },
        );

      return { verification, outcome: 'SESSION_LIMIT_REACHED' as const };
    });

    expect(outcome).toMatchObject({
      verification: { status: ChallengeVerificationStatus.VERIFIED },
      outcome: 'SESSION_LIMIT_REACHED',
    });
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
      select: { consumedAt: true },
    });
    expect(challenge.consumedAt).toBeInstanceOf(Date);
  });
  async function seedPolicy(
    context: ChallengeProofContext,
    name:
      | 'verificationIdentityShortTerm'
      | 'verificationIpShortTerm'
      | 'verificationIdentityLongTerm'
      | 'verificationIpLongTerm',
    boundary: bigint,
  ) {
    const policy = policies[name],
      settings = rates[name];
    const aliases = buckets
      .deriveKeys(
        policy,
        policy.characteristicKind === 'IDENTITY'
          ? context.normalizedIdentity
          : addresses.get(context.challengeId),
      )
      .buckets.map((bucket) => bucket.key);
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
    await inTransaction((tx) =>
      rateRepository.writeAliases(tx, aliases, policy.id, debt),
    );
  }

  it('admits six mismatches, denies correct proof without changing state, then consumes the same challenge after real recovery', async () => {
    const { context, proof } = await createChallenge();
    for (let i = 0; i < 6; i++)
      expect(await verifyOtp(context, wrongOtp(proof.otp))).toMatchObject({
        status: 'INVALID_PROOF',
        kind: 'MISMATCH',
        failedAttemptCount: i + 1,
        locked: false,
      });
    const before = await challengeState(context),
      debt = await state(context);
    const denial = await verifyLink(context, proof.linkToken);
    expect(denial.status).toBe('RATE_LIMITED');
    if (denial.status !== 'RATE_LIMITED')
      throw new Error('Expected rate denial.');
    expect(denial.retryAfterSeconds).toBeGreaterThan(0n);
    expect(await challengeState(context)).toEqual(before);
    expect(await state(context)).toEqual(debt);
    // Wait for the actual authoritative eligibility boundary, without resetting debt.
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0, (${denial.retryNotBeforeMicros.toString()}::numeric - EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
    expect(await verifyLink(context, proof.linkToken)).toMatchObject({
      status: 'VERIFIED',
    });
    expect(await state(context)).toEqual(debt); // success does not charge or repair
    expect(await verifyOtp(context, proof.otp)).toMatchObject({
      status: 'UNAVAILABLE',
      internalReason: 'CONSUMED',
    });
    const after = await challengeState(context);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.failedAttemptCount).toBe(6);
    expect(after.lockedAt).toBeNull();
  });

  it('shares all four budgets between OTP and link mismatches', async () => {
    const { context, proof } = await createChallenge();
    const wrongLink =
      Buffer.alloc(32, 7).toString('base64url') === proof.linkToken
        ? Buffer.alloc(32, 8).toString('base64url')
        : Buffer.alloc(32, 7).toString('base64url');
    for (let i = 0; i < 6; i++)
      expect(
        (
          await (i % 2
            ? verifyLink(context, wrongLink)
            : verifyOtp(context, wrongOtp(proof.otp)))
        ).status,
      ).toBe('INVALID_PROOF');
    expect((await verifyOtp(context, proof.otp)).status).toBe('RATE_LIMITED');
    const rows = await state(context);
    expect(new Set(rows.map((row) => row.policyId)).size).toBe(4);
    expect((await challengeState(context)).failedAttemptCount).toBe(6);
  });

  it('serializes competing challenges sharing identity across separate database clients without overspending', async () => {
    const identity = `competition-${randomUUID()}@example.edu`;
    const fixtures = await Promise.all(
      Array.from({ length: 12 }, () =>
        createChallenge({ normalizedIdentity: identity }),
      ),
    );
    const results = await Promise.all(
      fixtures.map(({ context, proof }, i) =>
        inTransaction(
          (tx) =>
            i % 2
              ? verificationService.verifyAndConsumeMagicLinkInTransaction(
                  tx,
                  verifyInput(
                    context,
                    Buffer.from(
                      Buffer.from(proof.linkToken, 'base64url').map(
                        (byte) => byte ^ 1,
                      ),
                    ).toString('base64url'),
                  ),
                )
              : verificationService.verifyAndConsumeOtpInTransaction(
                  tx,
                  verifyInput(context, wrongOtp(proof.otp)),
                ),
          i % 2 === 1,
        ),
      ),
    );
    expect(
      results.filter((result) => result.status === 'INVALID_PROOF'),
    ).toHaveLength(6);
    expect(
      results.filter((result) => result.status === 'RATE_LIMITED'),
    ).toHaveLength(6);
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: identity },
    });
    expect(challenges.reduce((sum, c) => sum + c.failedAttemptCount, 0)).toBe(
      6,
    );
    expect(
      challenges.every(
        (c) =>
          c.lockedAt === null &&
          c.encryptedProof !== null &&
          c.consumedAt === null,
      ),
    ).toBe(true);
    for (let i = 0; i < results.length; i++)
      if (results[i].status === 'RATE_LIMITED')
        expect(
          (await state(fixtures[i].context)).filter((row) =>
            row.policyId.includes('_IP_'),
          ),
        ).toEqual([]);
  });

  it.each([
    'verificationIdentityShortTerm',
    'verificationIdentityLongTerm',
    'verificationIpShortTerm',
    'verificationIpLongTerm',
  ] as const)(
    'requires %s before comparison, including correct proof',
    async (name) => {
      const { context, proof } = await createChallenge();
      await seedPolicy(
        context,
        name,
        (await rateRepository.operationNowMicros(prisma)) + 30_000_000n,
      );
      const before = await challengeState(context),
        debt = await state(context);
      expect(await verifyOtp(context, proof.otp)).toMatchObject({
        status: 'RATE_LIMITED',
        deniedPolicyIds: [policies[name].id],
      });
      expect(await challengeState(context)).toEqual(before);
      expect(await state(context)).toEqual(debt);
    },
  );

  it('retains committed mismatch accounting when the caller loses its result', async () => {
    const { context, proof } = await createChallenge();
    await expect(
      (async () => {
        await verifyOtp(context, wrongOtp(proof.otp));
        throw new Error('Simulated response loss after commit.');
      })(),
    ).rejects.toThrow('response loss');
    expect((await challengeState(context)).failedAttemptCount).toBe(1);
    expect(
      new Set((await state(context)).map((row) => row.policyId)).size,
    ).toBe(4);
  });

  it('rolls mismatch charges and diagnostics back on downstream owner failure', async () => {
    const { context, proof } = await createChallenge();
    const before = await challengeState(context);
    await expect(
      inTransaction(async (tx) => {
        expect(
          (
            await verificationService.verifyAndConsumeOtpInTransaction(
              tx,
              verifyInput(context, wrongOtp(proof.otp)),
            )
          ).status,
        ).toBe('INVALID_PROOF');
        throw new Error('Owner failed.');
      }),
    ).rejects.toThrow('Owner failed.');
    expect(await challengeState(context)).toEqual(before);
    expect(await state(context)).toEqual([]);
  });

  it('fails closed on corrupted limiter state and cryptographic infrastructure failure without changing the challenge', async () => {
    const { context, proof } = await createChallenge();
    await seedPolicy(
      context,
      'verificationIpLongTerm',
      (await rateRepository.operationNowMicros(prisma)) + 30_000_000n,
    );
    await prisma.gcraRateLimit.updateMany({
      where: { key: { in: keys(context) } },
      data: { policyId: 'WRONG_POLICY' },
    });
    const before = await challengeState(context),
      debt = await state(context);
    await expect(verifyOtp(context, proof.otp)).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(await challengeState(context)).toEqual(before);
    expect(await state(context)).toEqual(debt);
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: keys(context) } },
    });
    await prisma.authenticationChallenge.update({
      where: { id: context.challengeId },
      data: { hashKeyVersion: 999999 },
    });
    const unavailable = await challengeState(context);
    await expect(verifyOtp(context, proof.otp)).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    expect(await challengeState(context)).toEqual(unavailable);
    expect(await state(context)).toEqual([]);
  });

  it('enforces session binding before limiter or cryptographic comparison', async () => {
    const { context, proof } = await createChallenge();
    const before = await challengeState(context);
    expect(
      await inTransaction((tx) =>
        verificationService.verifyAndConsumeOtpInTransaction(tx, {
          ...verifyInput(context, proof.otp),
          expectedBoundSessionId: randomUUID(),
        }),
      ),
    ).toEqual({ status: 'UNAVAILABLE', internalReason: 'BINDING_MISMATCH' });
    expect(await challengeState(context)).toEqual(before);
    expect(await state(context)).toEqual([]);
  });

  it('rolls diagnostics and partial GCRA charges back even when the owner catches a late SQL failure', async () => {
    const { context, proof } = await createChallenge();
    const before = await challengeState(context);
    const key = buckets
      .deriveKeys(
        policies.verificationIpShortTerm,
        addresses.get(context.challengeId),
      )
      .buckets.map((bucket) => bucket.key)
      .sort()
      .at(-1)!;
    const schema = `verification_integrated_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
      throw new Error('Unexpected test key.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."key"=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected verification failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${key}')`,
      );
      const marker = `${subjectPrefix}owner:${randomUUID()}`;
      await inTransaction(async (tx) => {
        await tx.authenticationChallengeSubject.create({
          data: { key: marker },
        });
        await expect(
          verificationService.verifyAndConsumeOtpInTransaction(
            tx,
            verifyInput(context, wrongOtp(proof.otp)),
          ),
        ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
      });
      expect(
        await prisma.authenticationChallengeSubject.findUnique({
          where: { key: marker },
        }),
      ).not.toBeNull();
      expect(await challengeState(context)).toEqual(before);
      expect(await state(context)).toEqual([]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it.each(['advisory', 'row'] as const)(
    'rechecks expiry after %s bucket-lock waits before proof consumption',
    async (kind) => {
      const { context, proof } = await createChallenge({
        expiresAt: new Date(Date.now() + 900),
      });
      const policy = policies.verificationIdentityLongTerm;
      const alias = buckets.deriveKeys(policy, context.normalizedIdentity)
        .buckets[0].key;
      await seedPolicy(
        context,
        'verificationIdentityLongTerm',
        (await rateRepository.operationNowMicros(prisma)) - 10_000_000_000n,
      );
      const debt = await state(context);
      const ready = deferred(),
        release = deferred();
      const holding = inTransaction(async (tx) => {
        if (kind === 'advisory') await rateRepository.lockAliases(tx, [alias]);
        else
          await tx.$queryRaw`SELECT "key" FROM "GcraRateLimit" WHERE "key"=${alias} FOR UPDATE`;
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const pending = inTransaction(
        (tx) =>
          verificationService.verifyAndConsumeOtpInTransaction(
            tx,
            verifyInput(context, proof.otp),
          ),
        true,
      );
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await prisma.$queryRaw<
            { pid: number }[]
          >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock'`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release.resolve();
        await holding;
        expect(await pending).toEqual({
          status: 'UNAVAILABLE',
          internalReason: 'EXPIRED',
        });
        const after = await challengeState(context);
        expect(after.consumedAt).toBeNull();
        expect(after.failedAttemptCount).toBe(0);
        expect(after.encryptedProof).toBeNull();
        expect(await state(context)).toEqual(debt);
      } finally {
        release.resolve();
        await Promise.allSettled([holding, pending]);
      }
    },
  );
  it('preserves identity/IP debt through challenge retention cleanup and replacement', async () => {
    const { context, proof } = await createChallenge();
    for (let i = 0; i < 6; i++)
      expect((await verifyOtp(context, wrongOtp(proof.otp))).status).toBe(
        'INVALID_PROOF',
      );
    const debt = await state(context),
      address = addresses.get(context.challengeId)!;
    // Explicit historical lifecycle fixture: cleanup must not refund rate debt.
    await prisma.authenticationChallenge.update({
      where: { id: context.challengeId },
      data: {
        expiresAt: new Date(Date.now() - 2000),
        retentionExpiresAt: new Date(Date.now() - 1000),
      },
    });
    const cleanup = moduleFixture.get(AuthenticationChallengeCleanupRepository);
    await cleanup.clearOneExpiredEnvelopeBatch(100);
    await cleanup.deleteOneRetainedChallengeBatch(100);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: context.challengeId },
      }),
    ).toBeNull();
    expect(await state(context)).toEqual(debt);
    const replacement = await createChallenge({
      normalizedIdentity: context.normalizedIdentity,
      ipAddress: address,
    });
    expect(
      await verifyOtp(replacement.context, replacement.proof.otp),
    ).toMatchObject({ status: 'RATE_LIMITED' });
    expect((await challengeState(replacement.context)).failedAttemptCount).toBe(
      0,
    );
    expect(await state(replacement.context)).toEqual(debt);
  });

  it('migrates legacy terminal semantics without resetting healthy rows or GCRA debt', async () => {
    const { context } = await createChallenge();
    await seedPolicy(
      context,
      'verificationIdentityLongTerm',
      (await rateRepository.operationNowMicros(prisma)) + 30_000_000n,
    );
    const debt = await state(context);
    const schema = `verification_migration_${randomUUID().replaceAll('-', '')}`;
    const historical = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20260901000000_add_authentication_challenges/migration.sql',
      ),
      'utf8',
    );
    const createTable = historical.match(
      /CREATE TABLE "AuthenticationChallenge" \([\s\S]*?\n\);/,
    )?.[0];
    if (!createTable)
      throw new Error('Historical challenge definition missing.');
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20261111050000_replace_challenge_attempt_lock/migration.sql',
      ),
      'utf8',
    );
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await inTransaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL search_path TO "${schema}", public`,
        );
        await tx.$executeRawUnsafe(createTable);
        for (const kind of ['healthy', 'exhausted', 'locked', 'consumed']) {
          await tx.$executeRaw`INSERT INTO "AuthenticationChallenge" ("id","subjectKey","identityType","normalizedIdentity","purpose","otpHash","linkTokenHash","hashKeyVersion","encryptionKeyVersion","expiresAt","failedAttemptCount","maxAttempts","consumedAt","lockedAt","encryptedProof","proofEncryptionIv","proofEncryptionTag","retentionExpiresAt","updatedAt") VALUES (${kind},'subject','INSTITUTIONAL_EMAIL','legacy@example.edu','SIGN_IN','hash-otp','hash-link',1,1,clock_timestamp()+interval '10 minutes',${kind === 'healthy' ? 4 : 5},5,${kind === 'consumed' ? new Date('2026-01-01') : null},${kind === 'locked' ? new Date('2026-01-01') : null},${kind === 'healthy' || kind === 'exhausted' ? Buffer.from([1]) : null},${kind === 'healthy' || kind === 'exhausted' ? Buffer.from([2]) : null},${kind === 'healthy' || kind === 'exhausted' ? Buffer.from([3]) : null},clock_timestamp()+interval '1 day',clock_timestamp())`;
        }
        type Row = {
          id: string;
          maxAttempts?: number;
          lockedAt: Date | null;
          consumedAt: Date | null;
          encryptedProof: Uint8Array | null;
          failedAttemptCount: number;
          [key: string]: unknown;
        };
        const before = await tx.$queryRaw<
          Row[]
        >`SELECT * FROM "AuthenticationChallenge" ORDER BY "id"`;
        for (const statement of migration
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s && s !== 'BEGIN' && s !== 'COMMIT'))
          await tx.$executeRawUnsafe(statement);
        const after = await tx.$queryRaw<
          Row[]
        >`SELECT * FROM "AuthenticationChallenge" ORDER BY "id"`;
        for (const row of before) {
          const expected = { ...row };
          delete expected.maxAttempts;
          const changed = after.find((candidate) => candidate.id === row.id)!;
          if (row.id !== 'exhausted') expect(changed).toEqual(expected);
          else {
            expect(changed.lockedAt).not.toBeNull();
            expect(changed.consumedAt).toBeNull();
            expect(changed.encryptedProof).toBeNull();
            expect(changed.proofEncryptionIv).toBeNull();
            expect(changed.proofEncryptionTag).toBeNull();
            expect(changed.failedAttemptCount).toBe(5);
            expect(changed.expiresAt).toEqual(row.expiresAt);
            expect(changed.otpHash).toEqual(row.otpHash);
            expect(changed.linkTokenHash).toEqual(row.linkTokenHash);
          }
          expect(changed).not.toHaveProperty('maxAttempts');
        }
        await tx.$executeRaw`UPDATE "AuthenticationChallenge" SET "failedAttemptCount"=9 WHERE "id"='healthy'`;
        expect(
          (
            await tx.$queryRaw<
              Row[]
            >`SELECT * FROM "AuthenticationChallenge" WHERE "id"='healthy'`
          )[0],
        ).toMatchObject({ failedAttemptCount: 9, lockedAt: null });
        await tx.$executeRaw`SAVEPOINT negative_count`;
        await expect(
          tx.$executeRaw`UPDATE "AuthenticationChallenge" SET "failedAttemptCount"=-1 WHERE "id"='healthy'`,
        ).rejects.toMatchObject({ code: 'P2010' });
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT negative_count`;
      });
      expect(await state(context)).toEqual(debt);
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
