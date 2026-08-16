// NestJS
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

// Internal modules
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { GeoIpModule } from '../geo-ip/geo-ip.module';
import { SecurityModule } from '../security/security.module';
import { NotificationModule } from '../notifications/notification.module';

// Controllers
import { AuthController } from './auth.controller';

// Services
import { AuthService } from './auth.service';
import { JwtTokenService } from './services/jwt-token.service';
import { PasswordService } from './services/password.service';

// Guards
import { AccessTokenGuard } from './guards/access-token.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';
import { EmailVerificationService } from './services/email-verification.service';
import { SessionCreationService } from './session/services/session-creation.service';
import { SessionRefreshService } from './session/services/session-refresh.service';
import { SessionQueryService } from './session/services/session-query.service';
import { SessionManagementService } from './session/services/session-management.service';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({}),
    MailModule,
    GeoIpModule,
    SecurityModule,
    NotificationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    JwtTokenService,
    SecureTokenService,
    UsernameService,
    SessionCreationService,
    SessionRefreshService,
    SessionQueryService,
    SessionManagementService,
    EmailVerificationService,
    AccessTokenGuard,
    RefreshTokenGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
