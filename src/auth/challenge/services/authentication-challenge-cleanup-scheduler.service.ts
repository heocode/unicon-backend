// NestJS
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

// Services
import { AuthenticationChallengeCleanupService } from './authentication-challenge-cleanup.service';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';

@Injectable()
export class AuthenticationChallengeCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AuthenticationChallengeCleanupSchedulerService.name,
  );
  private cleanupTimer: NodeJS.Timeout | null = null;
  private scheduledRun: Promise<void> | null = null;

  constructor(
    private readonly cleanupService: AuthenticationChallengeCleanupService,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      this.startScheduledCleanup();
    }, this.config.cleanupIntervalSeconds * 1000);
    this.cleanupTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await this.scheduledRun;
  }

  private startScheduledCleanup(): void {
    if (this.scheduledRun) {
      return;
    }

    this.scheduledRun = this.runScheduledCleanup().finally(() => {
      this.scheduledRun = null;
    });
  }

  private async runScheduledCleanup(): Promise<void> {
    try {
      const result = await this.cleanupService.runOnce();

      if (
        !result.skippedAlreadyRunning &&
        (result.clearedExpiredProofCount > 0 ||
          result.deletedRetainedChallengeCount > 0 ||
          result.reachedBatchLimit)
      ) {
        this.logger.log(
          `Authentication challenge cleanup cleared ${result.clearedExpiredProofCount} expired proof envelope(s), deleted ${result.deletedRetainedChallengeCount} retained challenge(s), and executed ${result.executedBatchCount} batch(es).`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Authentication challenge cleanup failed; a later scheduled run will retry remaining records.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
