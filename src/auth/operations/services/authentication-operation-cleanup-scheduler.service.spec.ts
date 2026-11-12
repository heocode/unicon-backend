import { Logger } from '@nestjs/common';

import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationOperationCleanupService } from './authentication-operation-cleanup.service';
import { AuthenticationOperationCleanupSchedulerService } from './authentication-operation-cleanup-scheduler.service';

describe('AuthenticationOperationCleanupSchedulerService', () => {
  const cleanup = { runOnce: jest.fn() };
  let service: AuthenticationOperationCleanupSchedulerService;
  beforeEach(() => {
    jest.useFakeTimers();
    cleanup.runOnce.mockReset().mockResolvedValue({});
    service = new AuthenticationOperationCleanupSchedulerService(
      cleanup as unknown as AuthenticationOperationCleanupService,
      { cleanupIntervalSeconds: 60 } as AuthenticationChallengeConfigService,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.useRealTimers();
  });
  it('schedules bounded cleanup and removes its timer at shutdown', async () => {
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(cleanup.runOnce).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not overlap runs and waits for in-flight cleanup during shutdown', async () => {
    let release!: () => void;
    cleanup.runOnce.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(cleanup.runOnce).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    expect(stopped).toBe(true);
  });
  it('contains degraded cleanup failure and logs only a safe event', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      cleanup.runOnce.mockRejectedValue(new Error('Sensitive DB details.'));
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(logger.mock.calls).toEqual([
        [{ event: 'AUTHENTICATION_OPERATION_CLEANUP_FAILED' }],
      ]);
    } finally {
      logger.mockRestore();
    }
  });
});
