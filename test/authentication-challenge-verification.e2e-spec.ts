import { randomUUID } from 'crypto';

import { TestingModule, Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
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

  afterAll(async () => {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: subjectPrefix } },
    });
    await moduleFixture.close();
  });

  async function createChallenge(options?: {
    expiresAt?: Date;
    failedAttemptCount?: number;
    maxAttempts?: number;
  }): Promise<{
    context: ChallengeProofContext;
    proof: TransientChallengeDeliveryProof;
  }> {
    const id = randomUUID();
    const context: ChallengeProofContext = {
      challengeId: id,
      purpose: AuthenticationChallengePurpose.SIGN_IN,
      normalizedIdentity: `student-${id}@example.edu`,
    };
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
            otpHash: generated.persistence.hashing.otpHash,
            linkTokenHash: generated.persistence.hashing.linkTokenHash,
            hashProtocolVersion:
              generated.persistence.hashing.hashProtocolVersion,
            hashKeyVersion: generated.persistence.hashing.hashKeyVersion,
            encryptedProof: generated.persistence.encryption.encryptedProof,
            proofEncryptionIv:
              generated.persistence.encryption.proofEncryptionIv,
            proofEncryptionTag:
              generated.persistence.encryption.proofEncryptionTag,
            encryptionProtocolVersion:
              generated.persistence.encryption.encryptionProtocolVersion,
            encryptionKeyVersion:
              generated.persistence.encryption.encryptionKeyVersion,
            expiresAt:
              options?.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
            failedAttemptCount: options?.failedAttemptCount ?? 0,
            maxAttempts: options?.maxAttempts ?? 5,
            retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      },
    });

    return { context, proof: generated.deliveryProof };
  }

  function verifyOtp(
    context: ChallengeProofContext,
    proof: string,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return prisma.$transaction((transaction) =>
      verificationService.verifyAndConsumeOtpInTransaction(transaction, {
        challengeId: context.challengeId,
        expectedPurpose: context.purpose,
        proof,
      }),
    );
  }

  function verifyLink(
    context: ChallengeProofContext,
    proof: string,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return prisma.$transaction((transaction) =>
      verificationService.verifyAndConsumeMagicLinkInTransaction(transaction, {
        challengeId: context.challengeId,
        expectedPurpose: context.purpose,
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

  it('atomically locks and clears proof on the fifth canonical wrong OTP', async () => {
    const { context } = await createChallenge({ failedAttemptCount: 4 });

    const result = await verifyOtp(context, '999999');
    expect(result).toMatchObject({
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind: InvalidChallengeProofKind.MISMATCH,
      attemptConsumed: true,
      failedAttemptCount: 5,
      attemptsRemaining: 0,
      locked: true,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.failedAttemptCount).toBe(5);
    expect(challenge.lockedAt).toEqual(
      result.status === ChallengeVerificationStatus.INVALID_PROOF
        ? result.lockedAt
        : null,
    );
    expect(challenge.encryptedProof).toBeNull();
    expect(challenge.proofEncryptionIv).toBeNull();
    expect(challenge.proofEncryptionTag).toBeNull();
    expect(challenge.hashProtocolVersion).toBe(1);
    expect(challenge.encryptionProtocolVersion).toBe(1);
  });

  it('self-heals an exhausted unlocked challenge fail-closed', async () => {
    const { context } = await createChallenge({ failedAttemptCount: 5 });

    await expect(verifyOtp(context, '999999')).resolves.toEqual({
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason: InternalChallengeUnavailabilityReason.LOCKED,
    });

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.lockedAt).not.toBeNull();
    expect(challenge.encryptedProof).toBeNull();
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
      prisma.$transaction((transaction) =>
        verificationService.verifyAndConsumeOtpInTransaction(transaction, {
          challengeId: context.challengeId,
          expectedPurpose: AuthenticationChallengePurpose.STEP_UP,
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
    const { context } = await createChallenge();

    await Promise.all(
      Array.from({ length: 5 }, () => verifyOtp(context, '999999')),
    );

    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: context.challengeId },
    });
    expect(challenge.failedAttemptCount).toBe(5);
    expect(challenge.lockedAt).not.toBeNull();
    expect(challenge.encryptedProof).toBeNull();
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
      prisma.$transaction(async (transaction) => {
        const result =
          await verificationService.verifyAndConsumeOtpInTransaction(
            transaction,
            {
              challengeId: context.challengeId,
              expectedPurpose: context.purpose,
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

    const outcome = await prisma.$transaction(async (transaction) => {
      const verification =
        await verificationService.verifyAndConsumeOtpInTransaction(
          transaction,
          {
            challengeId: context.challengeId,
            expectedPurpose: context.purpose,
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
});
