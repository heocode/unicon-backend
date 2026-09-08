import { randomUUID } from 'crypto';

import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import {
  AuthenticationChallengePurpose,
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
  AuthenticationDeliveryStatus,
  AuthenticationIdentityType,
} from '../src/generated/prisma/enums';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Authentication delivery persistence (e2e)', () => {
  const subjectPrefix = 'e2e:delivery-persistence:';

  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let proofFactory: AuthenticationChallengeProofFactoryService;
  let challengeId: string;
  let recipient: string;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    prisma = moduleFixture.get(PrismaService);
    proofFactory = moduleFixture.get(
      AuthenticationChallengeProofFactoryService,
    );
  });

  beforeEach(async () => {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: subjectPrefix } },
    });

    challengeId = randomUUID();
    recipient = `student-${challengeId}@example.edu`;
    const proof = proofFactory.generate({
      challengeId,
      purpose: AuthenticationChallengePurpose.SIGN_IN,
      normalizedIdentity: recipient,
    });

    await prisma.authenticationChallenge.create({
      data: {
        id: challengeId,
        subject: { create: { key: `${subjectPrefix}${challengeId}` } },
        identityType: AuthenticationIdentityType.INSTITUTIONAL_EMAIL,
        normalizedIdentity: recipient,
        purpose: AuthenticationChallengePurpose.SIGN_IN,
        otpHash: proof.persistence.hashing.otpHash,
        linkTokenHash: proof.persistence.hashing.linkTokenHash,
        hashProtocolVersion: proof.persistence.hashing.hashProtocolVersion,
        hashKeyVersion: proof.persistence.hashing.hashKeyVersion,
        encryptedProof: proof.persistence.encryption.encryptedProof,
        proofEncryptionIv: proof.persistence.encryption.proofEncryptionIv,
        proofEncryptionTag: proof.persistence.encryption.proofEncryptionTag,
        encryptionProtocolVersion:
          proof.persistence.encryption.encryptionProtocolVersion,
        encryptionKeyVersion: proof.persistence.encryption.encryptionKeyVersion,
        expiresAt: new Date(Date.now() + 600_000),
        maxAttempts: 5,
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });

  afterAll(async () => {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: subjectPrefix } },
    });
    await moduleFixture.close();
  });

  const createDelivery = (
    overrides: Record<string, unknown> = {},
  ): Promise<unknown> =>
    prisma.authenticationChallengeDelivery.create({
      data: {
        challengeId,
        method: AuthenticationDeliveryMethod.EMAIL,
        origin: AuthenticationDeliveryOrigin.INITIAL,
        recipientSnapshot: recipient,
        idempotencyKey: randomUUID(),
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
        ...overrides,
      },
    });

  it('accepts representative pending and leased processing states', async () => {
    await expect(createDelivery()).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.PENDING,
      attemptCount: 0,
    });
    await expect(
      createDelivery({
        status: AuthenticationDeliveryStatus.PROCESSING,
        attemptCount: 1,
        processingLeaseId: randomUUID(),
        processingLeaseExpiresAt: new Date(Date.now() + 45_000),
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.PROCESSING,
      attemptCount: 1,
    });
  });

  it.each([
    [
      'PROCESSING without a complete lease',
      { status: AuthenticationDeliveryStatus.PROCESSING, attemptCount: 1 },
    ],
    [
      'PENDING with a lease',
      {
        processingLeaseId: randomUUID(),
        processingLeaseExpiresAt: new Date(Date.now() + 45_000),
      },
    ],
    ['SENT without sentAt', { status: AuthenticationDeliveryStatus.SENT }],
    [
      'FAILED without a safe reason',
      { status: AuthenticationDeliveryStatus.FAILED },
    ],
    [
      'CANCELLED without a safe reason',
      { status: AuthenticationDeliveryStatus.CANCELLED },
    ],
    ['a negative attempt count', { attemptCount: -1 }],
    [
      'a non-positive template protocol version',
      { templateProtocolVersion: 0 },
    ],
  ])('rejects %s', async (_case, overrides) => {
    await expect(createDelivery(overrides)).rejects.toThrow();
  });
});
