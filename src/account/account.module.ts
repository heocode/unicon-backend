// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { PasswordModule } from '../auth/password/password.module';
import { AuthSecurityModule } from '../auth/security/auth-security.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationModule } from '../notifications/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SecurityModule } from '../security/security.module';

// Controllers
import { AccountController } from './account.controller';

// Services
import { PasswordChangeService } from './services/password-change.service';
import { AccountDeletionService } from './services/account-deletion.service';
import { AccountDeletionCancellationRateLimitService } from './services/account-deletion-cancellation-rate-limit.service';
import { AccountDeletionFinalizationService } from './services/account-deletion-finalization.service';

@Module({
  imports: [
    AuthSecurityModule,
    AuthModule,
    PasswordModule,
    PrismaModule,
    SecurityModule,
    NotificationModule,
  ],
  controllers: [AccountController],
  providers: [
    PasswordChangeService,
    AccountDeletionService,
    AccountDeletionCancellationRateLimitService,
    AccountDeletionFinalizationService,
  ],
})
export class AccountModule {}
