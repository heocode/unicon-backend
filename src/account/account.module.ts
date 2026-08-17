// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { PasswordModule } from '../auth/password/password.module';
import { AuthSecurityModule } from '../auth/security/auth-security.module';
import { NotificationModule } from '../notifications/notification.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SecurityModule } from '../security/security.module';

// Controllers
import { AccountController } from './account.controller';

// Services
import { PasswordChangeService } from './services/password-change.service';

@Module({
  imports: [
    AuthSecurityModule,
    PasswordModule,
    PrismaModule,
    SecurityModule,
    NotificationModule,
  ],
  controllers: [AccountController],
  providers: [PasswordChangeService],
})
export class AccountModule {}
