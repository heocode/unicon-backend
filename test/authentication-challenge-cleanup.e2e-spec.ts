import { randomUUID } from 'crypto';

import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import {
  AuthenticationChallengePurpose,
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
  AuthenticationIdentityType,
} from '../src/generated/prisma/enums';
import {
  Prisma,
  type AuthenticationChallenge,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Authentication challenge cleanup (e2e)', () => {
  const subjectPrefix = 'e2e:challenge-cleanup:';

  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let repository: AuthenticationChallengeCleanupRepository;
  let proofFactory: AuthenticationChallengeProofFactoryService;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    repository = moduleFixture.get(AuthenticationChallengeCleanupRepository);
    proofFactory = moduleFixture.get(
      AuthenticationChallengeProofFactoryService,
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
    retentionExpiresAt?: Date;
    withDelivery?: boolean;
  }): Promise<AuthenticationChallenge> {
    const id = randomUUID();
    const normalizedIdentity = `student-${id}@example.edu`;
    const generated = proofFactory.generate({
      challengeId: id,
      purpose: AuthenticationChallengePurpose.SIGN_IN,
      normalizedIdentity,
    });

    return prisma.authenticationChallenge.create({
      data: {
        id,
        subject: {
          create: { key: `${subjectPrefix}${id}` },
        },
        identityType: AuthenticationIdentityType.INSTITUTIONAL_EMAIL,
        normalizedIdentity,
        purpose: AuthenticationChallengePurpose.SIGN_IN,
        otpHash: generated.persistence.hashing.otpHash,
        linkTokenHash: generated.persistence.hashing.linkTokenHash,
        hashProtocolVersion: generated.persistence.hashing.hashProtocolVersion,
        hashKeyVersion: generated.persistence.hashing.hashKeyVersion,
        encryptedProof: generated.persistence.encryption.encryptedProof,
        proofEncryptionIv: generated.persistence.encryption.proofEncryptionIv,
        proofEncryptionTag: generated.persistence.encryption.proofEncryptionTag,
        encryptionProtocolVersion:
          generated.persistence.encryption.encryptionProtocolVersion,
        encryptionKeyVersion:
          generated.persistence.encryption.encryptionKeyVersion,
        expiresAt: options?.expiresAt ?? new Date(Date.now() + 10 * 60 * 1000),
        maxAttempts: 5,
        retentionExpiresAt:
          options?.retentionExpiresAt ??
          new Date(Date.now() + 24 * 60 * 60 * 1000),
        deliveries: options?.withDelivery
          ? {
              create: {
                method: AuthenticationDeliveryMethod.EMAIL,
                origin: AuthenticationDeliveryOrigin.INITIAL,
                templateProtocolVersion: 1,
                recipientSnapshot: normalizedIdentity,
                idempotencyKey: randomUUID(),
                retentionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            }
          : undefined,
      },
    });
  }

  it('clears only the envelope of an expired challenge', async () => {
    const expired = await createChallenge({
      expiresAt: new Date(Date.now() - 60_000),
    });
    const active = await createChallenge();

    await expect(
      repository.clearOneExpiredEnvelopeBatch(100),
    ).resolves.toBeGreaterThanOrEqual(1);

    const cleaned = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: expired.id },
    });
    const untouched = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: active.id },
    });
    expect(cleaned.encryptedProof).toBeNull();
    expect(cleaned.proofEncryptionIv).toBeNull();
    expect(cleaned.proofEncryptionTag).toBeNull();
    expect(cleaned.otpHash).toEqual(expired.otpHash);
    expect(cleaned.linkTokenHash).toEqual(expired.linkTokenHash);
    expect(cleaned.encryptionProtocolVersion).toBe(
      expired.encryptionProtocolVersion,
    );
    expect(cleaned.encryptionKeyVersion).toBe(expired.encryptionKeyVersion);
    expect(cleaned.consumedAt).toBeNull();
    expect(cleaned.lockedAt).toBeNull();
    expect(untouched.encryptedProof).not.toBeNull();
  });

  it('deletes a retained challenge and cascades its delivery', async () => {
    const retained = await createChallenge({
      expiresAt: new Date(Date.now() - 120_000),
      retentionExpiresAt: new Date(Date.now() - 60_000),
      withDelivery: true,
    });
    const retainedDelivery =
      await prisma.authenticationChallengeDelivery.findFirstOrThrow({
        where: { challengeId: retained.id },
      });
    const current = await createChallenge();

    await expect(
      repository.deleteOneRetainedChallengeBatch(100),
    ).resolves.toBeGreaterThanOrEqual(1);

    await expect(
      prisma.authenticationChallenge.findUnique({
        where: { id: retained.id },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.authenticationChallengeDelivery.findUnique({
        where: { id: retainedDelivery.id },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.authenticationChallenge.findUnique({ where: { id: current.id } }),
    ).resolves.not.toBeNull();
  });

  it('skips a row currently locked by another transaction', async () => {
    const challenge = await createChallenge({
      expiresAt: new Date(Date.now() - 60_000),
    });
    let releaseLock: (() => void) | undefined;
    let reportLocked: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const lockingTransaction = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "AuthenticationChallenge"
        WHERE "id" = ${challenge.id}
        FOR UPDATE
      `);
      reportLocked?.();
      await release;
    });
    await locked;

    await expect(repository.clearOneExpiredEnvelopeBatch(100)).resolves.toBe(0);

    releaseLock?.();
    await lockingTransaction;
    const unchanged = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: challenge.id },
    });
    expect(unchanged.encryptedProof).not.toBeNull();
  });

  it('enforces the all-present or all-null envelope constraint', async () => {
    const challenge = await createChallenge();

    await expect(
      prisma.authenticationChallenge.update({
        where: { id: challenge.id },
        data: { proofEncryptionIv: null },
      }),
    ).rejects.toThrow();
  });
});
