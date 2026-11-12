import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';

import { AuthenticationChallengeConfigService } from '../../challenge/services/authentication-challenge-config.service';
import { AuthenticationOperationCleanupService } from './authentication-operation-cleanup.service';

@Injectable()
export class AuthenticationOperationCleanupSchedulerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(
    AuthenticationOperationCleanupSchedulerService.name,
  );
  private timer: NodeJS.Timeout | null = null;
  private run: Promise<void> | null = null;

  constructor(
    private readonly cleanup: AuthenticationOperationCleanupService,
    private readonly config: AuthenticationChallengeConfigService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.run) return;
      this.run = this.cleanup
        .runOnce()
        .then(() => undefined)
        .catch(() => {
          this.logger.error({
            event: 'AUTHENTICATION_OPERATION_CLEANUP_FAILED',
          });
        })
        .finally(() => {
          this.run = null;
        });
    }, this.config.cleanupIntervalSeconds * 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.run;
  }
}
