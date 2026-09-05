import { Logger } from '@nestjs/common';

import { AuthenticationChallengeCleanupService } from './authentication-challenge-cleanup.service';
import { AuthenticationChallengeCleanupSchedulerService } from './authentication-challenge-cleanup-scheduler.service';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';

describe('AuthenticationChallengeCleanupSchedulerService', () => {
  const cleanupService = { runOnce: jest.fn() };
  const config = { cleanupIntervalSeconds: 60 };
  let service: AuthenticationChallengeCleanupSchedulerService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = new AuthenticationChallengeCleanupSchedulerService(
      cleanupService as unknown as AuthenticationChallengeCleanupService,
      config as AuthenticationChallengeConfigService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('runs periodically and stops scheduling on module shutdown', async () => {
    cleanupService.runOnce.mockResolvedValue({
      clearedExpiredProofCount: 0,
      deletedRetainedChallengeCount: 0,
      executedBatchCount: 2,
      reachedBatchLimit: false,
      skippedAlreadyRunning: false,
    });

    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(cleanupService.runOnce).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not overlap scheduled runs and waits for one during shutdown', async () => {
    let finishRun: (() => void) | undefined;
    cleanupService.runOnce.mockReturnValue(
      new Promise((resolve) => {
        finishRun = () =>
          resolve({
            clearedExpiredProofCount: 0,
            deletedRetainedChallengeCount: 0,
            executedBatchCount: 2,
            reachedBatchLimit: false,
            skippedAlreadyRunning: false,
          });
      }),
    );

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(cleanupService.runOnce).toHaveBeenCalledTimes(1);

    let shutdownFinished = false;
    const shutdown = service.onModuleDestroy().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finishRun?.();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('contains a cleanup failure so authentication startup remains available', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    cleanupService.runOnce.mockRejectedValue(new Error('Database unavailable'));

    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(logger).toHaveBeenCalledWith(
      'Authentication challenge cleanup failed; a later scheduled run will retry remaining records.',
      expect.any(String),
    );
  });
});
