// NestJS
import { Injectable } from '@nestjs/common';

// Internal repositories
import { AuthenticationDeliveryCleanupRepository } from '../repositories/authentication-delivery-cleanup.repository';

// Internal services
import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';

// Internal types
import type { AuthenticationDeliveryCleanupSummary } from '../types/authentication-delivery-cleanup.type';

@Injectable()
export class AuthenticationDeliveryCleanupService {
  private runInProgress = false;

  constructor(
    private readonly repository: AuthenticationDeliveryCleanupRepository,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  async runOnce(): Promise<AuthenticationDeliveryCleanupSummary> {
    if (this.runInProgress) {
      return {
        deletedRetainedDeliveryCount: 0,
        executedBatchCount: 0,
        reachedBatchLimit: false,
        skippedAlreadyRunning: true,
      };
    }

    this.runInProgress = true;
    try {
      let deletedRetainedDeliveryCount = 0;
      let executedBatchCount = 0;
      let batchWasFull = true;

      while (
        batchWasFull &&
        executedBatchCount < this.config.cleanupMaxBatchesPerRun
      ) {
        const deleted = await this.repository.deleteOneRetainedTerminalBatch(
          this.config.cleanupBatchSize,
        );
        deletedRetainedDeliveryCount += deleted;
        executedBatchCount++;
        batchWasFull = deleted === this.config.cleanupBatchSize;
      }

      return {
        deletedRetainedDeliveryCount,
        executedBatchCount,
        reachedBatchLimit:
          batchWasFull &&
          executedBatchCount === this.config.cleanupMaxBatchesPerRun,
        skippedAlreadyRunning: false,
      };
    } finally {
      this.runInProgress = false;
    }
  }
}
