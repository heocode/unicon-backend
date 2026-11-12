import { AuthenticationChallengeCleanupRepository } from '../repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeCleanupService } from './authentication-challenge-cleanup.service';

describe('AuthenticationChallengeCleanupService', () => {
  const repository = {
    clearOneExpiredEnvelopeBatch: jest.fn(),
    deleteOneRetainedChallengeBatch: jest.fn(),
    deleteOneOrphanedSubjectBatch: jest.fn(),
  };
  const config = {
    cleanupBatchSize: 100,
    cleanupMaxBatchesPerRun: 10,
  };

  let service: AuthenticationChallengeCleanupService;

  beforeEach(() => {
    jest.resetAllMocks();
    config.cleanupBatchSize = 100;
    config.cleanupMaxBatchesPerRun = 10;
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValue(0);
    repository.deleteOneRetainedChallengeBatch.mockResolvedValue(0);
    repository.deleteOneOrphanedSubjectBatch.mockResolvedValue(0);
    service = new AuthenticationChallengeCleanupService(
      repository as unknown as AuthenticationChallengeCleanupRepository,
      config as AuthenticationChallengeConfigService,
    );
  });

  it('cycles bounded batches under one shared budget across all three phases', async () => {
    config.cleanupBatchSize = 100;
    config.cleanupMaxBatchesPerRun = 6;
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValue(100);
    repository.deleteOneRetainedChallengeBatch.mockResolvedValue(100);
    repository.deleteOneOrphanedSubjectBatch.mockResolvedValue(100);

    await expect(service.runOnce()).resolves.toEqual({
      clearedExpiredProofCount: 200,
      deletedRetainedChallengeCount: 200,
      deletedOrphanedSubjectCount: 200,
      executedBatchCount: 6,
      reachedBatchLimit: true,
      skippedAlreadyRunning: false,
    });

    expect(
      repository.clearOneExpiredEnvelopeBatch.mock.invocationCallOrder,
    ).toEqual([expect.any(Number), expect.any(Number)]);
    expect(
      repository.deleteOneRetainedChallengeBatch.mock.invocationCallOrder,
    ).toEqual([expect.any(Number), expect.any(Number)]);
    expect(
      repository.clearOneExpiredEnvelopeBatch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.deleteOneRetainedChallengeBatch.mock.invocationCallOrder[0],
    );
    expect(
      repository.deleteOneRetainedChallengeBatch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      repository.clearOneExpiredEnvelopeBatch.mock.invocationCallOrder[1],
    );
  });

  it('gives remaining budget to the phase that still has work', async () => {
    config.cleanupBatchSize = 100;
    config.cleanupMaxBatchesPerRun = 4;
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValueOnce(0);
    repository.deleteOneRetainedChallengeBatch
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(25);

    await expect(service.runOnce()).resolves.toEqual({
      clearedExpiredProofCount: 0,
      deletedRetainedChallengeCount: 125,
      deletedOrphanedSubjectCount: 0,
      executedBatchCount: 4,
      reachedBatchLimit: false,
      skippedAlreadyRunning: false,
    });
  });

  it('counts an empty database check as an executed batch', async () => {
    config.cleanupMaxBatchesPerRun = 10;
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValueOnce(0);
    repository.deleteOneRetainedChallengeBatch.mockResolvedValueOnce(0);

    await expect(service.runOnce()).resolves.toMatchObject({
      executedBatchCount: 3,
      reachedBatchLimit: false,
    });
  });

  it('skips a concurrent run and resets the guard after completion', async () => {
    let resolveFirstBatch: ((count: number) => void) | undefined;
    repository.clearOneExpiredEnvelopeBatch.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        resolveFirstBatch = resolve;
      }),
    );
    repository.deleteOneRetainedChallengeBatch.mockResolvedValue(0);

    const firstRun = service.runOnce();
    await expect(service.runOnce()).resolves.toMatchObject({
      skippedAlreadyRunning: true,
      executedBatchCount: 0,
    });

    resolveFirstBatch?.(0);
    await firstRun;

    repository.clearOneExpiredEnvelopeBatch.mockResolvedValueOnce(0);
    await expect(service.runOnce()).resolves.toMatchObject({
      skippedAlreadyRunning: false,
    });
  });

  it('does not starve any phase when the per-run budget is one batch', async () => {
    config.cleanupMaxBatchesPerRun = 1;
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValue(100);
    repository.deleteOneRetainedChallengeBatch.mockResolvedValue(100);
    repository.deleteOneOrphanedSubjectBatch.mockResolvedValue(100);
    expect(await service.runOnce()).toMatchObject({
      clearedExpiredProofCount: 100,
      executedBatchCount: 1,
    });
    expect(await service.runOnce()).toMatchObject({
      deletedRetainedChallengeCount: 100,
      executedBatchCount: 1,
    });
    expect(await service.runOnce()).toMatchObject({
      deletedOrphanedSubjectCount: 100,
      executedBatchCount: 1,
    });
    expect(repository.clearOneExpiredEnvelopeBatch).toHaveBeenCalledTimes(1);
    expect(repository.deleteOneRetainedChallengeBatch).toHaveBeenCalledTimes(1);
    expect(repository.deleteOneOrphanedSubjectBatch).toHaveBeenCalledTimes(1);
  });

  it('preserves committed work and releases the guard after a later batch fails', async () => {
    repository.clearOneExpiredEnvelopeBatch.mockResolvedValueOnce(100);
    repository.deleteOneRetainedChallengeBatch.mockRejectedValueOnce(
      new Error('Database unavailable'),
    );

    await expect(service.runOnce()).rejects.toThrow('Database unavailable');

    repository.clearOneExpiredEnvelopeBatch.mockResolvedValueOnce(0);
    repository.deleteOneRetainedChallengeBatch.mockResolvedValueOnce(0);
    await expect(service.runOnce()).resolves.toMatchObject({
      skippedAlreadyRunning: false,
    });
  });
});
