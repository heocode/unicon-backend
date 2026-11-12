import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationOperationRepository } from '../repositories/authentication-operation.repository';
import { AuthenticationOperationCleanupService } from './authentication-operation-cleanup.service';

function setup() {
  const repository = {
    deleteRetainedBatch: jest
      .fn<Promise<number>, [number]>()
      .mockResolvedValue(2),
  };
  const service = new AuthenticationOperationCleanupService(
    repository as unknown as AuthenticationOperationRepository,
    {
      cleanupBatchSize: 2,
      cleanupMaxBatchesPerRun: 3,
    } as AuthenticationChallengeConfigService,
  );
  return { service, repository };
}

describe('AuthenticationOperationCleanupService', () => {
  it('stops at the shared finite batch budget', async () => {
    const { service, repository } = setup();
    expect(await service.runOnce()).toEqual({
      deletedReceiptCount: 6,
      executedBatchCount: 3,
      reachedBatchLimit: true,
      skippedAlreadyRunning: false,
    });
    expect(repository.deleteRetainedBatch).toHaveBeenCalledTimes(3);
  });
  it('stops when the repository returns a partial batch', async () => {
    const { service, repository } = setup();
    repository.deleteRetainedBatch.mockResolvedValueOnce(1);
    expect(await service.runOnce()).toEqual({
      deletedReceiptCount: 1,
      executedBatchCount: 1,
      reachedBatchLimit: false,
      skippedAlreadyRunning: false,
    });
  });
  it('prevents overlap and releases its guard after failure', async () => {
    const { service, repository } = setup();
    let release!: () => void;
    repository.deleteRetainedBatch.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          release = () => resolve(0);
        }),
    );
    const first = service.runOnce();
    expect((await service.runOnce()).skippedAlreadyRunning).toBe(true);
    release();
    await first;
    repository.deleteRetainedBatch.mockRejectedValueOnce(
      new Error('Synthetic failure.'),
    );
    await expect(service.runOnce()).rejects.toThrow('Synthetic failure.');
    repository.deleteRetainedBatch.mockResolvedValue(0);
    expect((await service.runOnce()).skippedAlreadyRunning).toBe(false);
  });
});
