// NestJS
import { Injectable } from '@nestjs/common';

// Repositories
import { AuthenticationChallengeCleanupRepository } from '../repositories/authentication-challenge-cleanup.repository';

// Services
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';

// Types
import type { AuthenticationChallengeCleanupSummary } from '../types/authentication-challenge-cleanup.type';

@Injectable()
export class AuthenticationChallengeCleanupService {
  private runInProgress = false;
  private nextPhase = 0;

  constructor(
    private readonly repository: AuthenticationChallengeCleanupRepository,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  async runOnce(): Promise<AuthenticationChallengeCleanupSummary> {
    if (this.runInProgress) {
      return {
        clearedExpiredProofCount: 0,
        deletedRetainedChallengeCount: 0,
        deletedOrphanedSubjectCount: 0,
        executedBatchCount: 0,
        reachedBatchLimit: false,
        skippedAlreadyRunning: true,
      };
    }

    this.runInProgress = true;

    try {
      return await this.runBatches();
    } finally {
      this.runInProgress = false;
    }
  }

  private async runBatches(): Promise<AuthenticationChallengeCleanupSummary> {
    const counts = [0, 0, 0];
    const exhausted = [false, false, false];
    let executedBatchCount = 0;

    while (
      executedBatchCount < this.config.cleanupMaxBatchesPerRun &&
      exhausted.some((phase) => !phase)
    ) {
      const phase = this.nextPhase;
      this.nextPhase = (phase + 1) % 3;
      if (exhausted[phase]) continue;
      const affected =
        phase === 0
          ? await this.repository.clearOneExpiredEnvelopeBatch(
              this.config.cleanupBatchSize,
            )
          : phase === 1
            ? await this.repository.deleteOneRetainedChallengeBatch(
                this.config.cleanupBatchSize,
              )
            : await this.repository.deleteOneOrphanedSubjectBatch(
                this.config.cleanupBatchSize,
              );
      counts[phase] += affected;
      exhausted[phase] = affected < this.config.cleanupBatchSize;
      executedBatchCount++;
    }

    return {
      clearedExpiredProofCount: counts[0],
      deletedRetainedChallengeCount: counts[1],
      deletedOrphanedSubjectCount: counts[2],
      executedBatchCount,
      reachedBatchLimit:
        executedBatchCount === this.config.cleanupMaxBatchesPerRun &&
        exhausted.some((phase) => !phase),
      skippedAlreadyRunning: false,
    };
  }
}
