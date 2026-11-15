import {
  Prisma,
  type AuthenticationOperation,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { GcraAdmissionConfigService } from '../../../rate-limit/services/gcra-admission-config.service';
import { AuthenticationChallengeRequestService } from '../../challenge/services/authentication-challenge-request.service';
import type {
  AuthenticationSignInRequestInput,
  AuthenticationSignInRequestResult,
} from '../../challenge/types/authentication-challenge-request.type';
import { AuthenticationDeliveryAdmissionService } from '../../delivery/services/authentication-delivery-admission.service';
import { AuthenticationOperationRepository } from '../repositories/authentication-operation.repository';
import {
  createAuthenticationOperationId,
  authenticationOperationWindow,
} from '../utils/authentication-operation-id.util';
import { AuthenticationOperationService } from './authentication-operation.service';
import { AuthenticationOperationTelemetryService } from './authentication-operation-telemetry.service';
import type { AuthenticationOperationRequest } from '../types/authentication-operation.type';

const now = 1_800_000_000_123_000n;
const challengeId = '123e4567-e89b-42d3-a456-426614174000';
const deliveryId = '123e4567-e89b-42d3-a456-426614174001';
const request: AuthenticationOperationRequest = {
  kind: 'SIGN_IN_REQUEST',
  input: {
    normalizedIdentity: 'student@example.edu',
    ipAddress: '192.0.2.1',
    templateProtocolVersion: 1,
  },
};

function setup() {
  const id = createAuthenticationOperationId(now);
  let stored: AuthenticationOperation | null = null;
  const repository = {
    nowMicros: jest.fn().mockResolvedValue(now),
    lock: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockImplementation(() => Promise.resolve(stored)),
    insert: jest.fn(
      (
        _tx: unknown,
        data: Prisma.AuthenticationOperationUncheckedCreateInput,
      ) => {
        const boundary = data.retryNotBeforeMicros;
        if (boundary !== null && typeof boundary !== 'string')
          throw new Error('Expected an exact decimal string or null.');
        stored = {
          ...data,
          retryNotBeforeMicros:
            boundary === null ? null : new Prisma.Decimal(boundary),
        } as AuthenticationOperation;
        return Promise.resolve(stored);
      },
    ),
  };
  const requests = {
    requestSignInInTransaction: jest
      .fn<
        Promise<AuthenticationSignInRequestResult>,
        [Prisma.TransactionClient, AuthenticationSignInRequestInput]
      >()
      .mockResolvedValue({
        outcome: 'CREATED',
        challenge: {
          id: challengeId,
          expiresAt: new Date(Number(now / 1000n) + 600_000),
        },
        delivery: {
          id: deliveryId,
          challengeId,
          origin: 'INITIAL',
          method: 'EMAIL',
          idempotencyKey: 'provider-key',
        },
        operationNowMicros: now,
      }),
  };
  const deliveries = { admitResendInTransaction: jest.fn() };
  const prisma = {
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $executeRaw: jest.fn().mockResolvedValue(0) }),
    ),
  };
  const bounds = {
    maxAttempts: 3,
    timeoutSeconds: 5,
    maxWaitSeconds: 2,
  } as GcraAdmissionConfigService;
  const telemetry = { record: jest.fn<void | Promise<void>, [unknown]>() };
  const service = new AuthenticationOperationService(
    prisma as unknown as PrismaService,
    repository as unknown as AuthenticationOperationRepository,
    requests as unknown as AuthenticationChallengeRequestService,
    deliveries as unknown as AuthenticationDeliveryAdmissionService,
    bounds,
    telemetry as unknown as AuthenticationOperationTelemetryService,
  );
  return {
    id,
    service,
    telemetry,
    prisma,
    repository,
    requests,
    deliveries,
    readStored: () => stored,
    forget: () => {
      stored = null;
    },
  };
}

describe('AuthenticationOperationService (unit)', () => {
  it.each(['throw', 'reject', 'pending'] as const)(
    'keeps a committed result/replay outside a %s telemetry receiver',
    async (mode) => {
      const { id, service, telemetry, repository, requests } = setup();
      telemetry.record.mockImplementation(() => {
        if (mode === 'throw') throw new Error('Synthetic telemetry failure.');
        if (mode === 'reject')
          return Promise.reject(new Error('Synthetic telemetry failure.'));
        return new Promise<void>(() => {});
      });
      const first = await service.execute(id, request);
      const replay = await service.execute(id, request);
      expect(first.replayed).toBe(false);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(repository.insert).toHaveBeenCalledTimes(1);
      expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
      expect(telemetry.record).toHaveBeenCalledTimes(2);
      expect(telemetry.record.mock.calls[0][0]).toMatchObject({
        operation: 'SIGN_IN_REQUEST',
        outcome: 'CREATED',
        replayed: false,
      });
      expect(telemetry.record.mock.calls[1][0]).toMatchObject({
        outcome: 'CREATED',
        replayed: true,
      });
    },
  );
  it('preserves the original technical failure even if telemetry throws', async () => {
    const { id, service, telemetry, requests, repository } = setup();
    requests.requestSignInInTransaction.mockRejectedValue(
      new Error('Database failure.'),
    );
    telemetry.record.mockImplementation(() => {
      throw new Error('Synthetic telemetry failure.');
    });
    await expect(service.execute(id, request)).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    expect(repository.insert).not.toHaveBeenCalled();
    expect(telemetry.record.mock.calls[0][0]).toMatchObject({
      outcome: 'FAILURE',
      failureReason: 'STATE_UNAVAILABLE',
    });
  });
  it('commits a minimal receipt and replays it without another admission', async () => {
    const { id, service, requests, repository } = setup();
    const first = await service.execute(id, request);
    const replay = await service.execute(id, request);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
    expect(repository.insert).toHaveBeenCalledTimes(1);
    const data = repository.insert.mock.calls[0][1];
    expect(data).not.toHaveProperty('normalizedIdentity');
    expect(data).not.toHaveProperty('ipAddress');
    expect(data).not.toHaveProperty('deliveryProof');
    expect(data).not.toHaveProperty('providerIdempotencyKey');
    expect(
      requests.requestSignInInTransaction.mock.calls[0][1].idempotencyKey,
    ).not.toBe(id);
  });

  it('rejects a changed context instead of reusing or overwriting its receipt', async () => {
    const { id, service, requests, repository } = setup();
    await service.execute(id, request);
    await expect(
      service.execute(id, {
        kind: 'SIGN_IN_REQUEST',
        input: { ...request.input, normalizedIdentity: 'other@example.edu' },
      }),
    ).rejects.toMatchObject({ reason: 'OPERATION_CONFLICT' });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });

  it('reconciles a simulated lost commit acknowledgement by reading the committed receipt', async () => {
    const { id, service, requests, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      await callback({ $executeRaw: jest.fn().mockResolvedValue(0) });
      throw new Error('Lost commit acknowledgement.');
    });
    expect((await service.execute(id, request)).replayed).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
  });

  it('reports unresolved commit without replaying admission when reconciliation is unavailable', async () => {
    const { id, service, requests, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      await callback({ $executeRaw: jest.fn().mockResolvedValue(0) });
      throw new Error('Lost acknowledgement.');
    });
    prisma.$transaction.mockRejectedValueOnce(
      new Error('Database unavailable.'),
    );
    await expect(service.execute(id, request)).rejects.toMatchObject({
      reason: 'COMMIT_OUTCOME_UNKNOWN',
    });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not replay admission when fresh locked reconciliation proves absence after an uncertain acknowledgement', async () => {
    const { id, service, requests, prisma, forget } = setup();
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      await callback({ $executeRaw: jest.fn().mockResolvedValue(0) });
      forget();
      throw new Error('Uncertain commit.');
    });
    await expect(service.execute(id, request)).rejects.toMatchObject({
      reason: 'NOT_COMMITTED',
    });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
  });

  it('bounds only confirmed-abort retries and keeps the provider key stable across attempts', async () => {
    const { id, service, repository, requests } = setup();
    repository.insert.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Confirmed abort.', {
        code: 'P2034',
        clientVersion: 'test',
      }),
    );
    expect((await service.execute(id, request)).result.outcome).toBe('CREATED');
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(2);
    expect(
      requests.requestSignInInTransaction.mock.calls[0][1].idempotencyKey,
    ).toBe(requests.requestSignInInTransaction.mock.calls[1][1].idempotencyKey);
  });

  it('does not retry generic callback failures or fabricate a successful result', async () => {
    const { id, service, prisma, requests, repository } = setup();
    requests.requestSignInInTransaction.mockRejectedValue(
      new Error('40001 text is not a confirmed abort.'),
    );
    await expect(service.execute(id, request)).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('records a denial with its absolute deadline and never turns it into a later admission', async () => {
    const { id, service, repository, requests } = setup();
    requests.requestSignInInTransaction.mockResolvedValue({
      outcome: 'RATE_LIMITED',
      operationNowMicros: now,
      retryAfterSeconds: 54n,
      retryNotBeforeMicros: now + 54_000_000n,
      deniedPolicyIds: ['AUTH_IDENTITY_DELIVERY_COOLDOWN'],
    });
    expect((await service.execute(id, request)).result).toMatchObject({
      outcome: 'DENIED',
      remainingWaitSeconds: 54n,
    });
    repository.nowMicros.mockResolvedValue(now + 60_000_000n);
    expect((await service.execute(id, request)).result).toMatchObject({
      outcome: 'DENIED',
      remainingWaitSeconds: 0n,
    });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects expiry after downstream waits, before saving a receipt', async () => {
    const { id, service, repository } = setup();
    repository.nowMicros
      .mockResolvedValueOnce(now)
      .mockResolvedValueOnce(authenticationOperationWindow(id).expiresAtMicros);
    await expect(service.execute(id, request)).rejects.toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });
  it('persists and replays a global denial with its absolute boundary and remaining wait', async () => {
    const { id, service, repository, requests } = setup();
    requests.requestSignInInTransaction.mockResolvedValue({
      outcome: 'GLOBAL_RATE_DENIED',
      operationNowMicros: now,
      retryAfterSeconds: 10n,
      retryNotBeforeMicros: now + 10_000_000n,
      deniedPolicyIds: ['AUTH_DELIVERY_GLOBAL'],
    });
    expect((await service.execute(id, request)).result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
      remainingWaitSeconds: 10n,
    });
    repository.nowMicros.mockResolvedValue(now + 11_000_000n);
    expect((await service.execute(id, request)).result).toMatchObject({
      denial: 'GLOBAL_RATE_DENIED',
      remainingWaitSeconds: 0n,
    });
    expect(requests.requestSignInInTransaction).toHaveBeenCalledTimes(1);
  });
});
