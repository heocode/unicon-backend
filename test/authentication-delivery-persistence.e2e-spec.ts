import { randomUUID } from 'crypto';

import { Test, TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryCleanupRepository } from '../src/auth/delivery/repositories/authentication-delivery-cleanup.repository';
import {
  AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
  AuthenticationDeliveryCancellationReason,
  AuthenticationDeliveryClaimKind,
  AuthenticationDeliveryTransitionOutcome,
  type ClaimedAuthenticationDelivery,
} from '../src/auth/delivery/types/authentication-delivery.type';
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
  let repository: AuthenticationDeliveryRepository;
  let cleanupRepository: AuthenticationDeliveryCleanupRepository;
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
    repository = moduleFixture.get(AuthenticationDeliveryRepository);
    cleanupRepository = moduleFixture.get(
      AuthenticationDeliveryCleanupRepository,
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

  it('creates an initial delivery inside the caller transaction', async () => {
    const idempotencyKey = randomUUID();

    const delivery = await prisma.$transaction((transaction) =>
      repository.createInitialDelivery(transaction, {
        challengeId,
        recipientSnapshot: recipient,
        idempotencyKey,
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    );

    expect(delivery).toMatchObject({
      challengeId,
      method: AuthenticationDeliveryMethod.EMAIL,
      origin: AuthenticationDeliveryOrigin.INITIAL,
      idempotencyKey,
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

  it('allows only one replica to claim a pending delivery', async () => {
    const delivery = (await createDelivery()) as { id: string };

    const claims = await Promise.all([
      repository.claimNextDelivery(),
      repository.claimNextDelivery(),
    ]);
    const matchingClaims = claims.filter((claim) => claim?.id === delivery.id);

    expect(matchingClaims).toHaveLength(1);
    expect(matchingClaims[0]).toMatchObject({
      attemptCount: 1,
      claimKind: AuthenticationDeliveryClaimKind.NORMAL,
    });
  });

  it('claims fairly by oldest eligibility across pending, retry, and expired lease candidates', async () => {
    const now = Date.now();
    const pending = (await createDelivery({
      createdAt: new Date(now - 30_000),
    })) as { id: string };
    const retry = (await createDelivery({
      createdAt: new Date(now - 60_000),
      nextAttemptAt: new Date(now - 20_000),
    })) as { id: string };
    const expiredLease = (await createDelivery({
      status: AuthenticationDeliveryStatus.PROCESSING,
      attemptCount: 1,
      createdAt: new Date(now - 90_000),
      processingLeaseId: randomUUID(),
      processingLeaseExpiresAt: new Date(now - 10_000),
    })) as { id: string };

    const claims: (ClaimedAuthenticationDelivery | null)[] = [];
    for (let index = 0; index < 3; index++) {
      const claim = await repository.claimNextDelivery();
      claims.push(claim);
      await repository.markSent(claim!.id, claim!.leaseId);
    }

    expect(claims.map((claim) => claim?.id)).toEqual([
      pending.id,
      retry.id,
      expiredLease.id,
    ]);
    expect(claims[2]?.claimKind).toBe(
      AuthenticationDeliveryClaimKind.EXPIRED_LEASE_RECLAIM,
    );
  });

  it('reclaims an expired lease with a new owner and rejects the stale worker', async () => {
    const staleLeaseId = randomUUID();
    const delivery = (await createDelivery({
      status: AuthenticationDeliveryStatus.PROCESSING,
      attemptCount: 1,
      processingLeaseId: staleLeaseId,
      processingLeaseExpiresAt: new Date(Date.now() - 1_000),
    })) as { id: string };

    const claim = await repository.claimNextDelivery();

    expect(claim).toMatchObject({
      id: delivery.id,
      attemptCount: 2,
      claimKind: AuthenticationDeliveryClaimKind.EXPIRED_LEASE_RECLAIM,
    });
    expect(claim?.leaseId).not.toBe(staleLeaseId);
    await expect(repository.markSent(delivery.id, staleLeaseId)).resolves.toBe(
      AuthenticationDeliveryTransitionOutcome.LEASE_LOST,
    );
    await expect(
      repository.markSent(delivery.id, claim!.leaseId),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.APPLIED);

    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.SENT,
      providerMessageId: null,
    });
  });

  it('terminalizes an expired fifth lease without allowing a sixth claim', async () => {
    const delivery = (await createDelivery({
      status: AuthenticationDeliveryStatus.PROCESSING,
      attemptCount: 5,
      processingLeaseId: randomUUID(),
      processingLeaseExpiresAt: new Date(Date.now() - 1_000),
    })) as { id: string };

    await expect(repository.claimNextDelivery()).resolves.toBeNull();
    await expect(
      repository.terminalizeExpiredExhaustedLeases(100),
    ).resolves.toBe(1);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.FAILED,
      attemptCount: 5,
      lastSafeFailureCode:
        AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
      processingLeaseId: null,
    });
  });

  it('applies retry, failure, and cancellation only through the current lease', async () => {
    await createDelivery();
    const firstClaim = await repository.claimNextDelivery();
    const nextAttemptAt = new Date(Date.now() + 5_000);

    await expect(
      repository.scheduleRetry(
        firstClaim!.id,
        firstClaim!.leaseId,
        nextAttemptAt,
        'PROVIDER_UNAVAILABLE',
      ),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.APPLIED);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: firstClaim!.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.PENDING,
      nextAttemptAt,
      processingLeaseId: null,
      lastSafeFailureCode: 'PROVIDER_UNAVAILABLE',
    });

    await prisma.authenticationChallengeDelivery.update({
      where: { id: firstClaim!.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const secondClaim = await repository.claimNextDelivery();
    expect(secondClaim).toMatchObject({
      id: firstClaim!.id,
      attemptCount: 2,
      claimKind: AuthenticationDeliveryClaimKind.NORMAL,
    });
    await expect(
      repository.markFailed(
        secondClaim!.id,
        secondClaim!.leaseId,
        'RECIPIENT_REJECTED',
      ),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.APPLIED);
    await expect(
      repository.cancelOwnedDelivery(
        secondClaim!.id,
        secondClaim!.leaseId,
        AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
      ),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.LEASE_LOST);
  });

  it('cancels a currently owned delivery with a safe reason', async () => {
    await createDelivery();
    const claim = await repository.claimNextDelivery();

    await expect(
      repository.cancelOwnedDelivery(
        claim!.id,
        claim!.leaseId,
        AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
      ),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.APPLIED);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: claim!.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.CANCELLED,
      lastSafeFailureCode: 'DELIVERY_WINDOW_CLOSED',
      processingLeaseId: null,
    });
  });

  it('creates resend delivery without changing proof or challenge security state', async () => {
    const oldLeaseId = randomUUID();
    const oldDelivery = (await createDelivery({
      status: AuthenticationDeliveryStatus.PROCESSING,
      attemptCount: 1,
      processingLeaseId: oldLeaseId,
      processingLeaseExpiresAt: new Date(Date.now() + 45_000),
    })) as { id: string };
    const challengeBefore =
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      });

    const result = await repository.createResendDelivery({
      challengeId,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
    });

    expect(result).toMatchObject({
      outcome: 'CREATED',
      supersededDeliveryCount: 1,
      delivery: { origin: AuthenticationDeliveryOrigin.RESEND },
    });
    const challengeAfter =
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      });
    expect(challengeAfter.otpHash).toEqual(challengeBefore.otpHash);
    expect(challengeAfter.linkTokenHash).toEqual(challengeBefore.linkTokenHash);
    expect(challengeAfter.encryptedProof).toEqual(
      challengeBefore.encryptedProof,
    );
    expect(challengeAfter.expiresAt).toEqual(challengeBefore.expiresAt);
    expect(challengeAfter.failedAttemptCount).toBe(
      challengeBefore.failedAttemptCount,
    );
    await expect(
      repository.markFailed(oldDelivery.id, oldLeaseId, 'PROVIDER_REJECTED'),
    ).resolves.toBe(AuthenticationDeliveryTransitionOutcome.LEASE_LOST);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldDelivery.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.CANCELLED,
      lastSafeFailureCode: 'SUPERSEDED_BY_RESEND',
      processingLeaseId: null,
    });
  });

  it('rejects repository-level resend for an expired challenge', async () => {
    await prisma.authenticationChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      repository.createResendDelivery({
        challengeId,
        idempotencyKey: randomUUID(),
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).resolves.toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
  });

  it('deletes only retained terminal deliveries in a short cleanup transaction', async () => {
    const retainedSent = (await createDelivery({
      status: AuthenticationDeliveryStatus.SENT,
      sentAt: new Date(Date.now() - 2_000),
      retentionExpiresAt: new Date(Date.now() - 1_000),
    })) as { id: string };
    const retainedPending = (await createDelivery({
      retentionExpiresAt: new Date(Date.now() - 1_000),
    })) as { id: string };
    const futureFailed = (await createDelivery({
      status: AuthenticationDeliveryStatus.FAILED,
      lastSafeFailureCode: 'PROVIDER_REJECTED',
      retentionExpiresAt: new Date(Date.now() + 60_000),
    })) as { id: string };

    await expect(
      cleanupRepository.deleteOneRetainedTerminalBatch(100),
    ).resolves.toBe(1);
    await expect(
      prisma.authenticationChallengeDelivery.findUnique({
        where: { id: retainedSent.id },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.authenticationChallengeDelivery.findUnique({
        where: { id: retainedPending.id },
      }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.authenticationChallengeDelivery.findUnique({
        where: { id: futureFailed.id },
      }),
    ).resolves.not.toBeNull();
  });
});
