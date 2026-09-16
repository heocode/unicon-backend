// NestJS
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

// Internal services
import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationDeliveryCleanupService } from './authentication-delivery-cleanup.service';

@Injectable()
export class AuthenticationDeliveryCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AuthenticationDeliveryCleanupSchedulerService.name,
  );
  private timer: NodeJS.Timeout | null = null;
  private scheduledRun: Promise<void> | null = null;

  constructor(
    private readonly cleanupService: AuthenticationDeliveryCleanupService,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => this.startScheduledCleanup(),
      this.config.cleanupIntervalSeconds * 1_000,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
        (result.deletedRetainedDeliveryCount > 0 || result.reachedBatchLimit)
      ) {
        this.logger.log({
          event: 'AUTHENTICATION_DELIVERY_CLEANUP_COMPLETED',
          ...result,
        });
      }
    } catch {
      this.logger.error({
        event: 'AUTHENTICATION_DELIVERY_CLEANUP_FAILED',
      });
    }
  }
}
