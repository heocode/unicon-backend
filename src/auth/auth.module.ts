// NestJS
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

// Internal modules
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { GeoIpModule } from '../geo-ip/geo-ip.module';
import { SecurityModule } from '../security/security.module';
import { NotificationModule } from '../notifications/notification.module';
import { AuthSecurityModule } from './security/auth-security.module';
import { PasswordModule } from './password/password.module';

// Controllers
import { AuthController } from './auth.controller';

// Services
import { AuthService } from './auth.service';
import { JwtTokenService } from './services/jwt-token.service';

// Guards
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';
import { EmailVerificationService } from './services/email-verification.service';
import { SessionCreationService } from './session/services/session-creation.service';
import { SessionRefreshService } from './session/services/session-refresh.service';
import { SessionQueryService } from './session/services/session-query.service';
import { SessionManagementService } from './session/services/session-management.service';
import { PasswordRecoveryService } from './recovery/services/password-recovery.service';
import { RecoveryRateLimitService } from './recovery/services/recovery-rate-limit.service';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({}),
    MailModule,
    GeoIpModule,
    SecurityModule,
    NotificationModule,
    AuthSecurityModule,
    PasswordModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtTokenService,
    SecureTokenService,
    UsernameService,
    SessionCreationService,
    SessionRefreshService,
    SessionQueryService,
    SessionManagementService,
    EmailVerificationService,
    PasswordRecoveryService,
    RecoveryRateLimitService,
    RefreshTokenGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
