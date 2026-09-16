import { Logger } from '@nestjs/common';

import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationDeliveryCleanupSchedulerService } from './authentication-delivery-cleanup-scheduler.service';
import { AuthenticationDeliveryCleanupService } from './authentication-delivery-cleanup.service';

describe('AuthenticationDeliveryCleanupSchedulerService', () => {
  const cleanupService = { runOnce: jest.fn() };
  const config = { cleanupIntervalSeconds: 60 };
  let service: AuthenticationDeliveryCleanupSchedulerService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    cleanupService.runOnce.mockResolvedValue({
      deletedRetainedDeliveryCount: 0,
      executedBatchCount: 1,
      reachedBatchLimit: false,
      skippedAlreadyRunning: false,
    });
    service = new AuthenticationDeliveryCleanupSchedulerService(
      cleanupService as unknown as AuthenticationDeliveryCleanupService,
      config as AuthenticationChallengeConfigService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('runs on the shared cleanup interval and clears its timer on shutdown', async () => {
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);
    expect(cleanupService.runOnce).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('contains cleanup errors without logging raw exception details', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    cleanupService.runOnce.mockRejectedValue(
      new Error('database connection secret'),
    );
    service.onModuleInit();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(logger).toHaveBeenCalledWith({
      event: 'AUTHENTICATION_DELIVERY_CLEANUP_FAILED',
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain(
      'database connection secret',
    );
    logger.mockRestore();
  });
});
