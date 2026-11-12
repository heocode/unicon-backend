import { Injectable } from '@nestjs/common';

import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationOperationRepository } from '../repositories/authentication-operation.repository';

@Injectable()
export class AuthenticationOperationCleanupService {
  private running = false;

  constructor(
    private readonly repository: AuthenticationOperationRepository,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  async runOnce() {
    if (this.running)
      return {
        deletedReceiptCount: 0,
        executedBatchCount: 0,
        reachedBatchLimit: false,
        skippedAlreadyRunning: true,
      };
    this.running = true;
    try {
      let deletedReceiptCount = 0,
        executedBatchCount = 0,
        full = true;
      while (full && executedBatchCount < this.config.cleanupMaxBatchesPerRun) {
        const deleted = await this.repository.deleteRetainedBatch(
          this.config.cleanupBatchSize,
        );
        deletedReceiptCount += deleted;
        executedBatchCount++;
        full = deleted === this.config.cleanupBatchSize;
      }
      return {
        deletedReceiptCount,
        executedBatchCount,
        reachedBatchLimit:
          full && executedBatchCount === this.config.cleanupMaxBatchesPerRun,
        skippedAlreadyRunning: false,
      };
    } finally {
      this.running = false;
    }
  }
}
