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
import { AuthenticationChallengeConfigService } from './challenge/services/authentication-challenge-config.service';
import { AuthenticationChallengeProofService } from './challenge/services/authentication-challenge-proof.service';
import { AuthenticationChallengeRandomSourceService } from './challenge/services/authentication-challenge-random-source.service';
import { AuthenticationChallengeProofEncryptionService } from './challenge/services/authentication-challenge-proof-encryption.service';
import { AuthenticationChallengeProofFactoryService } from './challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationChallengeRepository } from './challenge/repositories/authentication-challenge.repository';
import { AuthenticationChallengeVerificationService } from './challenge/services/authentication-challenge-verification.service';
import { AuthenticationChallengeCleanupRepository } from './challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeCleanupService } from './challenge/services/authentication-challenge-cleanup.service';
import { AuthenticationChallengeCleanupSchedulerService } from './challenge/services/authentication-challenge-cleanup-scheduler.service';
import { AuthenticationDeliveryPolicyService } from './delivery/services/authentication-delivery-policy.service';
import { AuthenticationDeliveryRepository } from './delivery/repositories/authentication-delivery.repository';
import { AuthenticationMagicLinkService } from './delivery/services/authentication-magic-link.service';

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
    AuthenticationChallengeConfigService,
    AuthenticationChallengeProofService,
    AuthenticationChallengeRandomSourceService,
    AuthenticationChallengeProofEncryptionService,
    AuthenticationChallengeProofFactoryService,
    AuthenticationChallengeRepository,
    AuthenticationChallengeVerificationService,
    AuthenticationChallengeCleanupRepository,
    AuthenticationChallengeCleanupService,
    AuthenticationChallengeCleanupSchedulerService,
    AuthenticationDeliveryPolicyService,
    AuthenticationDeliveryRepository,
    AuthenticationMagicLinkService,
    RefreshTokenGuard,
  ],
  exports: [AuthService, SessionCreationService],
})
export class AuthModule {}
