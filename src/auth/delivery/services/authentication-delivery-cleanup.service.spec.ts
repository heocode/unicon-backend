import { AuthenticationDeliveryCleanupRepository } from '../repositories/authentication-delivery-cleanup.repository';
import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationDeliveryCleanupService } from './authentication-delivery-cleanup.service';

describe('AuthenticationDeliveryCleanupService', () => {
  const repository = { deleteOneRetainedTerminalBatch: jest.fn() };
  const config = { cleanupBatchSize: 100, cleanupMaxBatchesPerRun: 3 };
  let service: AuthenticationDeliveryCleanupService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthenticationDeliveryCleanupService(
      repository as unknown as AuthenticationDeliveryCleanupRepository,
      config as AuthenticationChallengeConfigService,
    );
  });

  it('uses short batches until the backlog is exhausted', async () => {
    repository.deleteOneRetainedTerminalBatch
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(25);

    await expect(service.runOnce()).resolves.toEqual({
      deletedRetainedDeliveryCount: 125,
      executedBatchCount: 2,
      reachedBatchLimit: false,
      skippedAlreadyRunning: false,
    });
  });

  it('stops at the configured maximum number of batches', async () => {
    repository.deleteOneRetainedTerminalBatch.mockResolvedValue(100);

    await expect(service.runOnce()).resolves.toMatchObject({
      deletedRetainedDeliveryCount: 300,
      executedBatchCount: 3,
      reachedBatchLimit: true,
    });
  });

  it('does not overlap cleanup runs', async () => {
    let finishBatch: (() => void) | undefined;
    repository.deleteOneRetainedTerminalBatch.mockReturnValue(
      new Promise((resolve) => {
        finishBatch = () => resolve(0);
      }),
    );

    const active = service.runOnce();
    await expect(service.runOnce()).resolves.toMatchObject({
      skippedAlreadyRunning: true,
    });
    finishBatch?.();
    await active;
  });
});
