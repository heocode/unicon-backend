import type { Prisma } from '../../../generated/prisma/client';

import { AuthenticationDeliveryAdmissionService } from '../../delivery/services/authentication-delivery-admission.service';
import {
  AuthenticationChallengeRequestRepository,
  type SignInChallengeCandidate,
} from '../repositories/authentication-challenge-request.repository';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeProofFactoryService } from './authentication-challenge-proof-factory.service';
import { AuthenticationChallengeRequestService } from './authentication-challenge-request.service';

const input = {
  normalizedIdentity: 'student@example.edu',
  ipAddress: '192.0.2.1',
  idempotencyKey: 'initial-key',
  templateProtocolVersion: 1,
};
const now = new Date('2030-01-01T00:00:00Z');

function setup(candidates: SignInChallengeCandidate[] = []) {
  const repository = {
    lockSignInSubject: jest.fn().mockResolvedValue('subject'),
    lockSignInCandidates: jest.fn().mockResolvedValue(candidates),
    getOperationTimestamp: jest.fn().mockResolvedValue(now),
    createSignInChallenge: jest.fn(
      (
        _tx: Prisma.TransactionClient,
        data: Parameters<
          AuthenticationChallengeRequestRepository['createSignInChallenge']
        >[1],
      ) => Promise.resolve({ id: data.id, expiresAt: data.expiresAt }),
    ),
  };
  const proofs = {
    generate: jest.fn().mockReturnValue({
      persistence: { hashing: {}, encryption: {} },
      deliveryProof: { otp: '123456', linkToken: 'transient-proof' },
    }),
  };
  const deliveries = {
    admitInitialInTransaction: jest.fn().mockResolvedValue({
      outcome: 'CREATED',
      delivery: { id: 'initial', origin: 'INITIAL' },
      operationNowMicros: 5n,
    }),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ isolation: 'read committed' }]),
    $executeRaw: jest
      .fn<Promise<number>, [TemplateStringsArray]>()
      .mockResolvedValue(0),
  };
  const transaction = tx as unknown as Prisma.TransactionClient;
  const service = new AuthenticationChallengeRequestService(
    repository,
    {
      ttlSeconds: 600,
      retentionSeconds: 86_400,
      maxAttempts: 5,
    } as AuthenticationChallengeConfigService,
    proofs as unknown as AuthenticationChallengeProofFactoryService,
    deliveries as unknown as AuthenticationDeliveryAdmissionService,
  );
  return { service, repository, proofs, deliveries, transaction, tx };
}

function candidate(
  overrides: Partial<SignInChallengeCandidate> = {},
): SignInChallengeCandidate {
  return {
    id: 'existing',
    expiresAt: new Date(now.getTime() + 60_000),
    failedAttemptCount: 3,
    maxAttempts: 5,
    hasProof: true,
    ...overrides,
  };
}

describe('AuthenticationChallengeRequestService (unit)', () => {
  it('reuses live proof even below the new-Delivery window without generating or admitting work', async () => {
    const live = candidate();
    const { service, proofs, repository, deliveries, transaction } = setup([
      live,
    ]);
    expect(
      await service.requestSignInInTransaction(transaction, input),
    ).toEqual({
      outcome: 'REUSED',
      challenge: { id: live.id, expiresAt: live.expiresAt },
    });
    expect(proofs.generate).not.toHaveBeenCalled();
    expect(deliveries.admitInitialInTransaction).not.toHaveBeenCalled();
    expect(repository.createSignInChallenge).not.toHaveBeenCalled();
    expect(
      repository.lockSignInCandidates.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.getOperationTimestamp.mock.invocationCallOrder[0],
    );
  });

  it.each([false, true])(
    'creates fixed-lifetime proof and INITIAL atomically (expired predecessor=%s)',
    async (expired) => {
      const { service, proofs, repository, deliveries, transaction } = setup(
        expired ? [candidate({ expiresAt: now })] : [],
      );
      const result = await service.requestSignInInTransaction(
        transaction,
        input,
      );
      expect(result.outcome).toBe('CREATED');
      const created = repository.createSignInChallenge.mock.calls[0][1];
      expect(created).toMatchObject({
        subjectKey: 'subject',
        normalizedIdentity: input.normalizedIdentity,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        retentionExpiresAt: new Date(now.getTime() + 86_400_000),
        maxAttempts: 5,
      });
      expect(created.id).not.toBe('existing');
      expect(created.persistence).toEqual({ hashing: {}, encryption: {} });
      expect(created).not.toHaveProperty('deliveryProof');
      expect(proofs.generate).toHaveBeenCalledWith({
        challengeId: created.id,
        normalizedIdentity: input.normalizedIdentity,
        purpose: 'SIGN_IN',
      });
      expect(deliveries.admitInitialInTransaction).toHaveBeenCalledWith(
        transaction,
        {
          ipAddress: input.ipAddress,
          idempotencyKey: input.idempotencyKey,
          templateProtocolVersion: input.templateProtocolVersion,
          challengeId: created.id,
          retentionExpiresAt: created.retentionExpiresAt,
        },
      );
    },
  );

  it('fails closed on multiple live candidates without selecting or rewriting one', async () => {
    const { service, transaction, proofs, deliveries } = setup([
      candidate(),
      candidate({ id: 'other' }),
    ]);
    await expect(
      service.requestSignInInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(proofs.generate).not.toHaveBeenCalled();
    expect(deliveries.admitInitialInTransaction).not.toHaveBeenCalled();
  });

  it.each([{ hasProof: false }, { failedAttemptCount: 5 }])(
    'preserves transitional unavailable live state (%j)',
    async (overrides) => {
      const { service, transaction, proofs } = setup([candidate(overrides)]);
      expect(
        await service.requestSignInInTransaction(transaction, input),
      ).toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
      expect(proofs.generate).not.toHaveBeenCalled();
    },
  );

  it.each(['RATE_LIMITED', 'DELIVERY_WINDOW_CLOSED', 'CHALLENGE_UNAVAILABLE'])(
    'rolls back candidate creation on returned %s',
    async (outcome) => {
      const { service, transaction, deliveries, tx } = setup();
      const denial =
        outcome === 'RATE_LIMITED'
          ? { outcome, retryAfterSeconds: 54n, deniedPolicyIds: ['identity'] }
          : { outcome };
      deliveries.admitInitialInTransaction.mockResolvedValue(denial);
      expect(
        await service.requestSignInInTransaction(transaction, input),
      ).toEqual(denial);
      expect(tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
        'SAVEPOINT unicon_challenge_request',
        'ROLLBACK TO SAVEPOINT unicon_challenge_request',
        'RELEASE SAVEPOINT unicon_challenge_request',
      ]);
    },
  );

  it('sanitizes creation errors after rolling back the operation', async () => {
    const { service, repository, transaction } = setup();
    repository.createSignInChallenge.mockRejectedValue(
      new Error('Sensitive DB details.'),
    );
    await expect(
      service.requestSignInInTransaction(transaction, input),
    ).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
      message: 'Authoritative GCRA admission could not be established.',
    });
  });

  it.each([
    ' Student@example.edu',
    'Student@example.edu',
    'student@example.edu\n',
  ])(
    'rejects a noncanonical identity before database work',
    async (normalizedIdentity) => {
      const { service, transaction, tx } = setup();
      await expect(
        service.requestSignInInTransaction(transaction, {
          ...input,
          normalizedIdentity,
        }),
      ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );
});
