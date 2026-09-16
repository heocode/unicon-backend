import { Logger } from '@nestjs/common';

import {
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
} from '../../../generated/prisma/enums';

import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';
import {
  AuthenticationDeliveryClaimKind,
  type ClaimedAuthenticationDelivery,
} from '../types/authentication-delivery.type';
import { AuthenticationDeliveryOrchestrationService } from './authentication-delivery-orchestration.service';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';
import { AuthenticationDeliveryWorkerService } from './authentication-delivery-worker.service';

describe('AuthenticationDeliveryWorkerService', () => {
  const repository = {
    terminalizeExpiredExhaustedLeases: jest.fn(),
    claimNextDelivery: jest.fn(),
  };
  const orchestration = { process: jest.fn() };
  const policy = {
    workerIntervalSeconds: 1,
    workerConcurrency: 4,
    workerMaxDeliveriesPerCycle: 20,
    workerExhaustedLeaseBatchSize: 100,
  };
  let service: AuthenticationDeliveryWorkerService;
  let loggerError: jest.SpyInstance;

  const delivery = (
    index: number,
    claimKind = AuthenticationDeliveryClaimKind.NORMAL,
  ): ClaimedAuthenticationDelivery => ({
    id: `delivery-${index}`,
    challengeId: `challenge-${index}`,
    method: AuthenticationDeliveryMethod.EMAIL,
    origin: AuthenticationDeliveryOrigin.INITIAL,
    recipientSnapshot: 'student@example.edu',
    idempotencyKey: `idempotency-${index}`,
    templateProtocolVersion: 1,
    attemptCount: 1,
    leaseId: `lease-${index}`,
    leaseExpiresAt: new Date('2026-09-14T12:00:45.000Z'),
    claimKind,
  });

  beforeAll(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterAll(() => {
    loggerError.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repository.terminalizeExpiredExhaustedLeases.mockResolvedValue(0);
    repository.claimNextDelivery.mockResolvedValue(null);
    orchestration.process.mockResolvedValue({ outcome: 'SENT' });
    service = new AuthenticationDeliveryWorkerService(
      repository as unknown as AuthenticationDeliveryRepository,
      orchestration as unknown as AuthenticationDeliveryOrchestrationService,
      policy as unknown as AuthenticationDeliveryPolicyService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('returns an empty cycle and terminalizes exhausted leases first', async () => {
    repository.terminalizeExpiredExhaustedLeases.mockResolvedValue(3);

    await expect(service.runOnce()).resolves.toMatchObject({
      claimedCount: 0,
      exhaustedLeaseCount: 3,
      skippedAlreadyRunning: false,
    });
    expect(repository.terminalizeExpiredExhaustedLeases).toHaveBeenCalledWith(
      100,
    );
  });

  it('runs every second and stops its timer during shutdown', async () => {
    jest.useFakeTimers();
    service.onModuleInit();

    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(repository.terminalizeExpiredExhaustedLeases).toHaveBeenCalledTimes(
      1,
    );

    await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('uses at most four per-replica lanes and claims only from a free lane', async () => {
    const pending = Array.from({ length: 8 }, (_, index) => delivery(index));
    repository.claimNextDelivery.mockImplementation(() => {
      return pending.shift() ?? null;
    });
    let active = 0;
    let maximumActive = 0;
    orchestration.process.mockImplementation(async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active--;
      return { outcome: 'SENT' };
    });

    const result = await service.runOnce();

    expect(result.claimedCount).toBe(8);
    expect(result.sentCount).toBe(8);
    expect(maximumActive).toBeLessThanOrEqual(4);
    expect(repository.claimNextDelivery).toHaveBeenCalledTimes(12);
  });

  it('enforces the shared twenty-claim cycle limit without a leased local queue', async () => {
    let nextIndex = 0;
    repository.claimNextDelivery.mockImplementation(() =>
      delivery(nextIndex++),
    );

    const result = await service.runOnce();

    expect(result.claimedCount).toBe(20);
    expect(result.reachedCycleLimit).toBe(true);
    expect(repository.claimNextDelivery).toHaveBeenCalledTimes(20);
    expect(orchestration.process).toHaveBeenCalledTimes(20);
  });

  it('counts normal and expired-lease reclaim claims separately', async () => {
    const pending = [
      delivery(1),
      delivery(2, AuthenticationDeliveryClaimKind.EXPIRED_LEASE_RECLAIM),
    ];
    repository.claimNextDelivery.mockImplementation(
      () => pending.shift() ?? null,
    );

    await expect(service.runOnce()).resolves.toMatchObject({
      claimedCount: 2,
      normalClaimCount: 1,
      reclaimedClaimCount: 1,
    });
  });

  it('isolates an unexpected orchestration exception and continues', async () => {
    const pending = [delivery(1), delivery(2)];
    repository.claimNextDelivery.mockImplementation(
      () => pending.shift() ?? null,
    );
    orchestration.process
      .mockRejectedValueOnce(new Error('secret internal error'))
      .mockResolvedValueOnce({ outcome: 'SENT' });

    await expect(service.runOnce()).resolves.toMatchObject({
      claimedCount: 2,
      sentCount: 1,
      unexpectedFailureCount: 1,
    });
    expect(loggerError).toHaveBeenCalledWith({
      event: 'AUTHENTICATION_DELIVERY_ORCHESTRATION_UNEXPECTED_FAILURE',
      deliveryId: 'delivery-1',
      challengeId: 'challenge-1',
      attemptCount: 1,
      claimKind: AuthenticationDeliveryClaimKind.NORMAL,
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'secret internal error',
    );
  });

  it('stops new claims after a database claim failure', async () => {
    repository.claimNextDelivery.mockRejectedValue(new Error('database down'));

    await expect(service.runOnce()).resolves.toMatchObject({
      claimedCount: 0,
      stoppedByClaimFailure: true,
    });
    expect(orchestration.process).not.toHaveBeenCalled();
  });

  it('does not overlap cycles and waits for the active cycle on shutdown', async () => {
    let finishClaim: (() => void) | undefined;
    repository.claimNextDelivery.mockReturnValue(
      new Promise((resolve) => {
        finishClaim = () => resolve(null);
      }),
    );

    const activeRun = service.runOnce();
    await expect(service.runOnce()).resolves.toMatchObject({
      skippedAlreadyRunning: true,
    });
    let shutdownFinished = false;
    const shutdown = service.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finishClaim?.();
    await activeRun;
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
