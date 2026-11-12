import type { Prisma } from '../../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { AuthenticationDeliveryRateLimitService } from '../../rate-limit/services/authentication-delivery-rate-limit.service';
import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';
import { AuthenticationDeliveryAdmissionService } from './authentication-delivery-admission.service';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';

const input = {
  challengeId: '123e4567-e89b-42d3-a456-426614174000',
  ipAddress: '::ffff:192.0.2.1',
  idempotencyKey: 'delivery-key',
  templateProtocolVersion: 1,
  retentionExpiresAt: new Date('2030-01-01T00:00:00Z'),
};
const delivery = {
  id: 'delivery',
  challengeId: input.challengeId,
  method: 'EMAIL' as const,
  origin: 'RESEND' as const,
  idempotencyKey: input.idempotencyKey,
};

function setup() {
  const ready = {
    outcome: 'READY',
    challengeId: input.challengeId,
    normalizedIdentity: 'student@example.edu',
    expiresAtMicros: 1_000_000_000n,
  };
  const repository = {
    getResendContextInTransaction: jest.fn().mockResolvedValue(ready),
    createResendDeliveryInTransaction: jest
      .fn()
      .mockResolvedValue({ outcome: 'CREATED', delivery }),
    createInitialDelivery: jest
      .fn()
      .mockResolvedValue({ ...delivery, origin: 'INITIAL' }),
  };
  const rateLimits = {
    admitInTransaction: jest
      .fn()
      .mockResolvedValue({ allowed: true, operationNowMicros: 100n }),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ isolation: 'read committed' }]),
    $executeRaw: jest
      .fn<Promise<number>, [TemplateStringsArray]>()
      .mockResolvedValue(0),
  };
  const transaction = tx as unknown as Prisma.TransactionClient;
  const service = new AuthenticationDeliveryAdmissionService(
    repository as unknown as AuthenticationDeliveryRepository,
    rateLimits as unknown as AuthenticationDeliveryRateLimitService,
    { minValidityRemainingSeconds: 120 } as AuthenticationDeliveryPolicyService,
  );
  return { service, repository, rateLimits, transaction, tx, ready };
}

describe('AuthenticationDeliveryAdmissionService (unit)', () => {
  it('composes INITIAL with the same window/policies and authoritative recipient', async () => {
    const { service, repository, rateLimits, transaction } = setup();
    expect(
      await service.admitInitialInTransaction(transaction, input),
    ).toMatchObject({ outcome: 'CREATED', delivery: { origin: 'INITIAL' } });
    expect(repository.createInitialDelivery).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ recipientSnapshot: 'student@example.edu' }),
    );
    expect(
      rateLimits.admitInTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.createInitialDelivery.mock.invocationCallOrder[0],
    );
    expect(repository.createResendDeliveryInTransaction).not.toHaveBeenCalled();
  });

  it('does not turn existing work into a second INITIAL admission', async () => {
    const { service, repository, transaction, rateLimits } = setup();
    repository.getResendContextInTransaction.mockResolvedValue({
      outcome: 'EXISTING',
      delivery,
    });
    await expect(
      service.admitInitialInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(rateLimits.admitInTransaction).not.toHaveBeenCalled();
    expect(repository.createInitialDelivery).not.toHaveBeenCalled();
  });
  it('uses authoritative context and normalizes IP before jointly charging and inserting', async () => {
    const { service, repository, rateLimits, transaction, ready } = setup();
    expect(await service.admitResendInTransaction(transaction, input)).toEqual({
      outcome: 'CREATED',
      delivery,
      operationNowMicros: 100n,
    });
    expect(rateLimits.admitInTransaction).toHaveBeenCalledWith(
      transaction,
      {
        challengeId: ready.challengeId,
        normalizedIdentity: ready.normalizedIdentity,
        ipAddress: '192.0.2.1',
      },
      {
        expiresAtMicros: ready.expiresAtMicros,
        minValidityRemainingSeconds: 120,
      },
    );
    expect(
      rateLimits.admitInTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.createResendDeliveryInTransaction.mock.invocationCallOrder[0],
    );
  });

  it.each(['EXISTING', 'CHALLENGE_UNAVAILABLE'])(
    'resolves %s before touching rate policies or inserting work',
    async (outcome) => {
      const { service, repository, rateLimits, transaction } = setup();
      const context =
        outcome === 'EXISTING' ? { outcome, delivery } : { outcome };
      repository.getResendContextInTransaction.mockResolvedValue(context);
      expect(
        await service.admitResendInTransaction(transaction, input),
      ).toEqual(context);
      expect(rateLimits.admitInTransaction).not.toHaveBeenCalled();
      expect(
        repository.createResendDeliveryInTransaction,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(['DELIVERY_WINDOW_CLOSED', 'CHALLENGE_UNAVAILABLE'])(
    'returns %s from the common post-lock timestamp without insertion',
    async (windowOutcome) => {
      const { service, repository, rateLimits, transaction } = setup();
      rateLimits.admitInTransaction.mockResolvedValue({
        allowed: false,
        windowOutcome,
        operationNowMicros: 500n,
      });
      expect(
        await service.admitResendInTransaction(transaction, input),
      ).toEqual({ outcome: windowOutcome });
      expect(
        repository.createResendDeliveryInTransaction,
      ).not.toHaveBeenCalled();
    },
  );

  it('preserves authoritative wait and policy attribution on denial', async () => {
    const { service, repository, rateLimits, transaction } = setup();
    rateLimits.admitInTransaction.mockResolvedValue({
      allowed: false,
      operationNowMicros: 5n,
      retryAfterSeconds: 54n,
      retryNotBeforeMicros: 54_000_005n,
      deniedPolicyIds: ['cooldown'],
    });
    expect(await service.admitResendInTransaction(transaction, input)).toEqual({
      outcome: 'RATE_LIMITED',
      retryAfterSeconds: 54n,
      operationNowMicros: 5n,
      retryNotBeforeMicros: 54_000_005n,
      deniedPolicyIds: ['cooldown'],
    });
    expect(repository.createResendDeliveryInTransaction).not.toHaveBeenCalled();
  });

  it.each([
    new Error('Sensitive database details.'),
    new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED'),
  ])(
    'rolls back the entire operation and exposes only a safe infrastructure error',
    async (failure) => {
      const { service, repository, transaction, tx } = setup();
      repository.createResendDeliveryInTransaction.mockRejectedValue(failure);
      await expect(
        service.admitResendInTransaction(transaction, input),
      ).rejects.toMatchObject({
        reason:
          failure instanceof GcraAdmissionInfrastructureError
            ? 'TRANSACTION_ABORTED'
            : 'STATE_UNAVAILABLE',
      });
      expect(tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
        'SAVEPOINT unicon_delivery_admission',
        'ROLLBACK TO SAVEPOINT unicon_delivery_admission',
        'RELEASE SAVEPOINT unicon_delivery_admission',
      ]);
    },
  );

  it('rejects an unexpected persistence result after charge and rolls back', async () => {
    const { service, repository, transaction } = setup();
    repository.createResendDeliveryInTransaction.mockResolvedValue({
      outcome: 'EXISTING',
      delivery,
    });
    await expect(
      service.admitResendInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it.each([undefined, '192.0.2.1:80'])(
    'fails closed on invalid source metadata before database access',
    async (ipAddress) => {
      const { service, transaction, tx } = setup();
      await expect(
        service.admitResendInTransaction(transaction, { ...input, ipAddress }),
      ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('rejects a second admission in the same transaction even after existing-work resolution', async () => {
    const { service, repository, transaction } = setup();
    repository.getResendContextInTransaction.mockResolvedValue({
      outcome: 'EXISTING',
      delivery,
    });
    await service.admitResendInTransaction(transaction, input);
    await expect(
      service.admitResendInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(repository.getResendContextInTransaction).toHaveBeenCalledTimes(1);
  });
});
