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

  constructor(
    private readonly repository: AuthenticationChallengeCleanupRepository,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  async runOnce(): Promise<AuthenticationChallengeCleanupSummary> {
    if (this.runInProgress) {
      return {
        clearedExpiredProofCount: 0,
        deletedRetainedChallengeCount: 0,
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
    let clearedExpiredProofCount = 0;
    let deletedRetainedChallengeCount = 0;
    let executedBatchCount = 0;
    let envelopeCleanupExhausted = false;
    let retentionDeletionExhausted = false;
    let clearEnvelopeNext = true;

    while (
      executedBatchCount < this.config.cleanupMaxBatchesPerRun &&
      (!envelopeCleanupExhausted || !retentionDeletionExhausted)
    ) {
      const shouldClearEnvelope =
        !envelopeCleanupExhausted &&
        (clearEnvelopeNext || retentionDeletionExhausted);

      if (shouldClearEnvelope) {
        const affected = await this.repository.clearOneExpiredEnvelopeBatch(
          this.config.cleanupBatchSize,
        );
        clearedExpiredProofCount += affected;
        envelopeCleanupExhausted = affected < this.config.cleanupBatchSize;
        clearEnvelopeNext = false;
      } else {
        const affected = await this.repository.deleteOneRetainedChallengeBatch(
          this.config.cleanupBatchSize,
        );
        deletedRetainedChallengeCount += affected;
        retentionDeletionExhausted = affected < this.config.cleanupBatchSize;
        clearEnvelopeNext = true;
      }

      executedBatchCount++;
    }

    return {
      clearedExpiredProofCount,
      deletedRetainedChallengeCount,
      executedBatchCount,
      reachedBatchLimit:
        executedBatchCount === this.config.cleanupMaxBatchesPerRun &&
        (!envelopeCleanupExhausted || !retentionDeletionExhausted),
      skippedAlreadyRunning: false,
    };
  }
}
