import { randomUUID } from 'crypto';

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

import { AppModule } from '../src/app.module';
import { AuthenticationEmailProviderPort } from '../src/auth/delivery/ports/authentication-email-provider.port';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import {
  AuthenticationEmailRetryKind,
  type AuthenticationEmailProviderResult,
  type AuthenticationEmailSubmission,
} from '../src/auth/delivery/types/authentication-email-provider.type';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryPolicyService } from '../src/auth/delivery/services/authentication-delivery-policy.service';
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
import { Prisma } from '../src/generated/prisma/client';

describe('Authentication delivery persistence (e2e)', () => {
  const subjectPrefix = 'e2e:delivery-persistence:';
  const replicaName = `delivery_persistence_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let replica: PrismaService;
  let replicaRepository: AuthenticationDeliveryRepository;
  let proofFactory: AuthenticationChallengeProofFactoryService;
  let repository: AuthenticationDeliveryRepository;
  let cleanupRepository: AuthenticationDeliveryCleanupRepository;
  let challengeId: string;
  let recipient: string;
  let orchestration: AuthenticationDeliveryOrchestrationService;
  const provider = {
    submit: jest.fn<
      Promise<AuthenticationEmailProviderResult>,
      [AuthenticationEmailSubmission]
    >(),
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthenticationEmailProviderPort)
      .useValue(provider)
      .compile();
    prisma = moduleFixture.get(PrismaService);
    proofFactory = moduleFixture.get(
      AuthenticationChallengeProofFactoryService,
    );
    repository = moduleFixture.get(AuthenticationDeliveryRepository);
    const replicaUrl = new URL(
      moduleFixture.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    replicaUrl.searchParams.set('application_name', replicaName);
    const replicaConfig = new ConfigService({
      DATABASE_URL: replicaUrl.toString(),
    });
    replica = new PrismaService(replicaConfig);
    await replica.$connect();
    replicaRepository = new AuthenticationDeliveryRepository(
      replica,
      moduleFixture.get(AuthenticationDeliveryPolicyService),
    );
    orchestration = moduleFixture.get(
      AuthenticationDeliveryOrchestrationService,
    );
    cleanupRepository = moduleFixture.get(
      AuthenticationDeliveryCleanupRepository,
    );
  });

  beforeEach(async () => {
    provider.submit.mockReset();
    provider.submit.mockResolvedValue({ outcome: 'ACCEPTED' });
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
    await replica.$disconnect();
  });

  const resendInput = () => ({
    challengeId,
    idempotencyKey: randomUUID(),
    templateProtocolVersion: 1,
    retentionExpiresAt: new Date(Date.now() + 86_400_000),
  });

  const initialInput = () => ({
    ...resendInput(),
    recipientSnapshot: recipient,
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

  it.each(['expired', 'consumed', 'locked'])(
    'terminalizes and retains a pending Delivery for a %s challenge',
    async (state) => {
      const delivery = (await createDelivery()) as { id: string };
      await prisma.authenticationChallenge.update({
        where: { id: challengeId },
        data: {
          ...(state === 'expired'
            ? { expiresAt: new Date(Date.now() - 1_000) }
            : {}),
          ...(state === 'consumed' ? { consumedAt: new Date() } : {}),
          ...(state === 'locked' ? { lockedAt: new Date() } : {}),
          encryptedProof: null,
          proofEncryptionIv: null,
          proofEncryptionTag: null,
        },
      });
      const claim = await repository.claimNextDelivery();
      expect(claim?.id).toBe(delivery.id);
      await expect(orchestration.process(claim!)).resolves.toEqual({
        outcome: 'CANCELLED',
      });
      await expect(
        prisma.authenticationChallengeDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        }),
      ).resolves.toMatchObject({
        status: AuthenticationDeliveryStatus.CANCELLED,
      });
      expect(provider.submit).not.toHaveBeenCalled();
      await prisma.authenticationChallengeDelivery.update({
        where: { id: delivery.id },
        data: { retentionExpiresAt: new Date(Date.now() - 1_000) },
      });
      await expect(
        cleanupRepository.deleteOneRetainedTerminalBatch(100),
      ).resolves.toBe(1);
    },
  );

  it('reproduces immutable submissions through two real processing attempts', async () => {
    const delivery = (await createDelivery()) as { id: string };
    provider.submit.mockResolvedValueOnce({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
      safeFailureCode: 'RESEND_TRANSPORT_OUTCOME_UNKNOWN',
    });
    const first = await repository.claimNextDelivery();
    await expect(orchestration.process(first!)).resolves.toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    await prisma.authenticationChallengeDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) },
    });
    const second = await repository.claimNextDelivery();
    expect(second?.attemptCount).toBe(2);
    await expect(orchestration.process(second!)).resolves.toEqual({
      outcome: 'SENT',
    });
    const firstSubmission = provider.submit.mock.calls[0][0];
    const secondSubmission = provider.submit.mock.calls[1][0];
    expect(secondSubmission).toEqual(firstSubmission);
    expect(firstSubmission.content.inlineAttachments).toHaveLength(1);
    expect(firstSubmission.content.html).toContain('cid:unicon-logo-v1');
    expect(firstSubmission.content.subject).toMatch(
      /^\d{6} — Your Unicon sign-in code$/,
    );
  });

  it('recovers a crashed worker and rejects all late transitions from its old lease', async () => {
    const delivery = (await createDelivery()) as { id: string };
    const disappearedWorker = await repository.claimNextDelivery();
    await prisma.authenticationChallengeDelivery.update({
      where: { id: delivery.id },
      data: { processingLeaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await repository.claimNextDelivery();
    expect(recovered?.claimKind).toBe(
      AuthenticationDeliveryClaimKind.EXPIRED_LEASE_RECLAIM,
    );
    expect(recovered?.attemptCount).toBe(2);
    await expect(orchestration.process(recovered!)).resolves.toEqual({
      outcome: 'SENT',
    });
    for (const transition of [
      repository.markSent(delivery.id, disappearedWorker!.leaseId),
      repository.markFailed(
        delivery.id,
        disappearedWorker!.leaseId,
        'PROVIDER_REJECTED',
      ),
      repository.scheduleRetry(
        delivery.id,
        disappearedWorker!.leaseId,
        new Date(),
        'PROVIDER_RETRY',
      ),
      repository.cancelOwnedDelivery(
        delivery.id,
        disappearedWorker!.leaseId,
        AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
      ),
      repository.markInternalFailure(delivery.id, disappearedWorker!.leaseId),
    ]) {
      await expect(transition).resolves.toBe(
        AuthenticationDeliveryTransitionOutcome.LEASE_LOST,
      );
    }
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
      }),
    ).resolves.toMatchObject({ status: AuthenticationDeliveryStatus.SENT });
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

  it.each([false, true])(
    'terminalizes an exhausted pending Delivery (unavailable=%s)',
    async (unavailable) => {
      const delivery = (await createDelivery({ attemptCount: 5 })) as {
        id: string;
      };
      if (unavailable) {
        await prisma.authenticationChallenge.update({
          where: { id: challengeId },
          data: {
            consumedAt: new Date(),
            encryptedProof: null,
            proofEncryptionIv: null,
            proofEncryptionTag: null,
          },
        });
      }
      await expect(repository.claimNextDelivery()).resolves.toBeNull();
      await expect(
        repository.terminalizeExpiredExhaustedLeases(100),
      ).resolves.toBe(1);
      await expect(
        prisma.authenticationChallengeDelivery.findUniqueOrThrow({
          where: { id: delivery.id },
        }),
      ).resolves.toMatchObject({
        status: unavailable
          ? AuthenticationDeliveryStatus.CANCELLED
          : AuthenticationDeliveryStatus.FAILED,
        attemptCount: 5,
        lastSafeFailureCode: unavailable
          ? 'CHALLENGE_UNAVAILABLE'
          : AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
      });
    },
  );

  it('returns in-flight work without revoking provider ownership or submitting again', async () => {
    await createDelivery();
    const oldClaim = (await repository.claimNextDelivery())!;
    let releaseProvider!: () => void;
    let enteredProvider!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredProvider = resolve;
    });
    provider.submit.mockImplementationOnce(async () => {
      enteredProvider();
      await new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      return { outcome: 'ACCEPTED' };
    });
    const processing = orchestration.process(oldClaim);
    await entered;
    const before =
      await prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldClaim.id },
      });
    const resend = await repository.createResendDelivery({
      challengeId,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(resend).toMatchObject({
      outcome: 'EXISTING',
      delivery: { id: oldClaim.id },
    });
    expect(
      await prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldClaim.id },
      }),
    ).toEqual(before);
    releaseProvider();
    await expect(processing).resolves.toEqual({ outcome: 'SENT' });
    expect(provider.submit).toHaveBeenCalledTimes(1);
    await expect(repository.claimNextDelivery()).resolves.toBeNull();
    expect(
      await prisma.authenticationChallengeDelivery.count({
        where: { challengeId },
      }),
    ).toBe(1);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldClaim.id },
      }),
    ).resolves.toMatchObject({
      status: AuthenticationDeliveryStatus.SENT,
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

  it('creates resend after terminal work without changing proof or challenge security state', async () => {
    const oldDelivery = (await createDelivery({
      status: AuthenticationDeliveryStatus.SENT,
      attemptCount: 1,
      sentAt: new Date(),
    })) as { id: string };
    const deliveryBefore =
      await prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldDelivery.id },
      });
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
      delivery: { origin: AuthenticationDeliveryOrigin.RESEND },
    });
    const challengeAfter =
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      });
    expect(challengeAfter).toEqual(challengeBefore);
    await expect(
      prisma.authenticationChallengeDelivery.findUniqueOrThrow({
        where: { id: oldDelivery.id },
      }),
    ).resolves.toEqual(deliveryBefore);
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

  it.each(['PENDING', 'PROCESSING'] as const)(
    'returns existing %s work without changing schedule, lease, proof or audit fields',
    async (status) => {
      const delivery = await createDelivery(
        status === 'PROCESSING'
          ? {
              status,
              attemptCount: 1,
              processingLeaseId: randomUUID(),
              processingLeaseExpiresAt: new Date(Date.now() - 1_000),
            }
          : {
              attemptCount: 1,
              nextAttemptAt: new Date(Date.now() + 90_000),
              lastSafeFailureCode: 'PROVIDER_UNAVAILABLE',
            },
      );
      const challengeBefore =
        await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: challengeId },
        });
      const result = await prisma.$transaction((tx) =>
        repository.createResendDeliveryInTransaction(tx, resendInput()),
      );
      expect(result).toMatchObject({
        outcome: 'EXISTING',
        delivery: { id: (delivery as { id: string }).id },
      });
      expect(
        await prisma.authenticationChallengeDelivery.findMany({
          where: { challengeId },
        }),
      ).toEqual([delivery]);
      expect(
        await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: challengeId },
        }),
      ).toEqual(challengeBefore);
    },
  );

  it.each(['SENT', 'FAILED', 'CANCELLED'] as const)(
    'allows a new resend after %s, using the authoritative recipient',
    async (status) => {
      await createDelivery(
        status === 'SENT'
          ? { status, sentAt: new Date() }
          : {
              status,
              lastSafeFailureCode:
                status === 'FAILED'
                  ? 'PROVIDER_REJECTED'
                  : 'CHALLENGE_UNAVAILABLE',
            },
      );
      const value = resendInput();
      const result = await prisma.$transaction((tx) =>
        repository.createResendDeliveryInTransaction(tx, value),
      );
      expect(result).toMatchObject({
        outcome: 'CREATED',
        delivery: { origin: 'RESEND', idempotencyKey: value.idempotencyKey },
      });
      expect(
        await prisma.authenticationChallengeDelivery.findMany({
          where: { challengeId, status: 'PENDING' },
        }),
      ).toMatchObject([
        {
          recipientSnapshot: recipient,
          attemptCount: 0,
          processingLeaseId: null,
        },
      ]);
    },
  );

  it('serializes concurrent resends across independent clients into one new Delivery', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? replicaRepository : repository).createResendDelivery(
          resendInput(),
        ),
      ),
    );
    expect(
      results.filter((result) => result.outcome === 'CREATED'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'EXISTING'),
    ).toHaveLength(11);
    const deliveries = await prisma.authenticationChallengeDelivery.findMany({
      where: { challengeId },
    });
    expect(deliveries).toHaveLength(1);
    for (const result of results)
      expect(result).toMatchObject({ delivery: { id: deliveries[0].id } });
  });

  it('serializes mixed initial and resend creation across independent clients', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        index % 2
          ? replica.$transaction((tx) =>
              replicaRepository.createInitialDelivery(tx, initialInput()),
            )
          : repository.createResendDelivery(resendInput()),
      ),
    );
    const deliveries = await prisma.authenticationChallengeDelivery.findMany({
      where: { challengeId },
    });
    expect(deliveries).toHaveLength(1);
    const created = results.filter(
      (result) =>
        result.status === 'fulfilled' &&
        (!('outcome' in result.value) || result.value.outcome === 'CREATED'),
    );
    expect(created).toHaveLength(1);
    for (const result of results) {
      if (result.status === 'rejected')
        expect(result.reason).toEqual(
          new Error('Authentication delivery work already exists.'),
        );
      else if ('outcome' in result.value)
        expect(result.value).toMatchObject({
          delivery: { id: deliveries[0].id },
        });
    }
  });

  it('rolls back a new resend with the caller transaction and permits a later creation', async () => {
    const challengeBefore =
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      });
    await expect(
      prisma.$transaction(async (tx) => {
        expect(
          await repository.createResendDeliveryInTransaction(tx, resendInput()),
        ).toMatchObject({ outcome: 'CREATED' });
        await tx.authenticationChallengeSubject.create({
          data: { key: `${subjectPrefix}rollback-marker` },
        });
        throw new Error('Caller failed.');
      }),
    ).rejects.toThrow('Caller failed.');
    expect(
      await prisma.authenticationChallengeDelivery.count({
        where: { challengeId },
      }),
    ).toBe(0);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: `${subjectPrefix}rollback-marker` },
      }),
    ).toBeNull();
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
      }),
    ).toEqual(challengeBefore);
    expect(await repository.createResendDelivery(resendInput())).toMatchObject({
      outcome: 'CREATED',
    });
  });

  it('rolls back initial persistence with the caller transaction', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await repository.createInitialDelivery(tx, initialInput());
        throw new Error('Initial caller failed.');
      }),
    ).rejects.toThrow('Initial caller failed.');
    expect(
      await prisma.authenticationChallengeDelivery.count({
        where: { challengeId },
      }),
    ).toBe(0);
  });

  it('sends stable proof in a new resend after the previous Delivery was sent', async () => {
    await createDelivery();
    const first = (await repository.claimNextDelivery())!;
    expect(await orchestration.process(first)).toEqual({ outcome: 'SENT' });
    expect(await repository.createResendDelivery(resendInput())).toMatchObject({
      outcome: 'CREATED',
    });
    const second = (await repository.claimNextDelivery())!;
    expect(second.id).not.toBe(first.id);
    expect(await orchestration.process(second)).toEqual({ outcome: 'SENT' });
    expect(provider.submit).toHaveBeenCalledTimes(2);
    const [firstSubmission, secondSubmission] = provider.submit.mock.calls.map(
      ([submission]) => submission,
    );
    expect(secondSubmission.content).toEqual(firstSubmission.content);
    expect(secondSubmission.idempotencyKey).not.toBe(
      firstSubmission.idempotencyKey,
    );
  });

  it.each([
    'AuthenticationChallenge',
    'AuthenticationChallengeDelivery',
  ] as const)(
    'uses fresh DB time after waiting on %s, rejecting a challenge that expired during the wait',
    async (table) => {
      const delivery = (await createDelivery()) as { id: string };
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt" = clock_timestamp() + INTERVAL '1 second' WHERE "id" = ${challengeId}`;
      let ready!: (tx: Prisma.TransactionClient) => void;
      let release!: () => void;
      const readyPromise = new Promise<Prisma.TransactionClient>((resolve) => {
        ready = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${table === 'AuthenticationChallenge' ? challengeId : delivery.id} FOR UPDATE`,
          );
          ready(tx);
          await releasePromise;
        },
        { timeout: 10_000 },
      );
      const control = await readyPromise;
      const pending = replicaRepository.createResendDelivery(resendInput());
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = await prisma.$queryRaw<
            { pid: number }[]
          >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        const [live] = await prisma.$queryRaw<
          { live: boolean }[]
        >`SELECT "expiresAt" > clock_timestamp() AS live FROM "AuthenticationChallenge" WHERE "id"=${challengeId}`;
        expect(live.live).toBe(true);
        await control.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release();
        await holding;
        expect(await pending).toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
        expect(
          await prisma.authenticationChallengeDelivery.count({
            where: { challengeId },
          }),
        ).toBe(1);
      } finally {
        release();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  it.each(['consumed', 'locked', 'attempts', 'envelope'])(
    'does not resolve or mutate pending work for a challenge unavailable due to %s',
    async (state) => {
      await createDelivery();
      await prisma.authenticationChallenge.update({
        where: { id: challengeId },
        data: {
          ...(state === 'consumed' ? { consumedAt: new Date() } : {}),
          ...(state === 'locked' ? { lockedAt: new Date() } : {}),
          ...(state === 'attempts'
            ? { failedAttemptCount: 5 }
            : {
                encryptedProof: null,
                proofEncryptionIv: null,
                proofEncryptionTag: null,
              }),
        },
      });
      const before = await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId },
      });
      expect(await repository.createResendDelivery(resendInput())).toEqual({
        outcome: 'CHALLENGE_UNAVAILABLE',
      });
      expect(
        await prisma.authenticationChallengeDelivery.findMany({
          where: { challengeId },
        }),
      ).toEqual(before);
    },
  );

  it('rejects missing challenges without creating Delivery', async () => {
    const missing = { ...resendInput(), challengeId: randomUUID() };
    expect(await repository.createResendDelivery(missing)).toEqual({
      outcome: 'CHALLENGE_UNAVAILABLE',
    });
  });

  it('fails closed without cancelling or repairing historical duplicate unfinished work', async () => {
    await createDelivery();
    await createDelivery();
    const before = await prisma.authenticationChallengeDelivery.findMany({
      where: { challengeId },
      orderBy: { id: 'asc' },
    });
    await expect(
      repository.createResendDelivery(resendInput()),
    ).rejects.toThrow('unfinished-work invariant');
    expect(
      await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(before);
  });

  it('requires real supported transactions for both creation paths', async () => {
    await expect(
      repository.createResendDeliveryInTransaction(prisma, resendInput()),
    ).rejects.toThrow('interactive transaction');
    await expect(
      repository.createInitialDelivery(prisma, initialInput()),
    ).rejects.toThrow('interactive transaction');
    await expect(
      prisma.$transaction(
        (tx) => repository.createResendDeliveryInTransaction(tx, resendInput()),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        },
      ),
    ).rejects.toThrow('isolation is unsupported');
    expect(
      await prisma.authenticationChallengeDelivery.count({
        where: { challengeId },
      }),
    ).toBe(0);
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
