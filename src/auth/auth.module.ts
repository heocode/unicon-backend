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
import { RateLimitModule } from '../rate-limit/rate-limit.module';

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
import { AuthenticationChallengeRequestRepository } from './challenge/repositories/authentication-challenge-request.repository';
import { AuthenticationChallengeFinalizationRepository } from './challenge/repositories/authentication-challenge-finalization.repository';
import { AuthenticationChallengeRequestService } from './challenge/services/authentication-challenge-request.service';
import { AuthenticationChallengeVerificationService } from './challenge/services/authentication-challenge-verification.service';
import { AuthenticationChallengeCleanupRepository } from './challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeCleanupService } from './challenge/services/authentication-challenge-cleanup.service';
import { AuthenticationChallengeCleanupSchedulerService } from './challenge/services/authentication-challenge-cleanup-scheduler.service';
import { AuthenticationDeliveryPolicyService } from './delivery/services/authentication-delivery-policy.service';
import { AuthenticationDeliveryBacklogRepository } from './delivery/repositories/authentication-delivery-backlog.repository';
import { AuthenticationDeliveryRepository } from './delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryAdmissionService } from './delivery/services/authentication-delivery-admission.service';
import { AuthenticationMagicLinkService } from './delivery/services/authentication-magic-link.service';
import { AuthenticationEmailTemplateService } from './delivery/services/authentication-email-template.service';
import { AuthenticationDeliveryOrchestrationService } from './delivery/services/authentication-delivery-orchestration.service';
import { AuthenticationDeliveryRandomSourceService } from './delivery/services/authentication-delivery-random-source.service';
import { AuthenticationDeliveryWorkerService } from './delivery/services/authentication-delivery-worker.service';
import { AuthenticationDeliveryCleanupRepository } from './delivery/repositories/authentication-delivery-cleanup.repository';
import { AuthenticationDeliveryCleanupService } from './delivery/services/authentication-delivery-cleanup.service';
import { AuthenticationDeliveryCleanupSchedulerService } from './delivery/services/authentication-delivery-cleanup-scheduler.service';
import { AuthenticationRateLimitConfigService } from './rate-limit/services/authentication-rate-limit-config.service';
import { AuthenticationDeliveryCooldownRepository } from './rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationDeliveryRateLimitService } from './rate-limit/services/authentication-delivery-rate-limit.service';
import { AuthenticationVerificationRateLimitService } from './rate-limit/services/authentication-verification-rate-limit.service';
import { AuthenticationOperationRepository } from './operations/repositories/authentication-operation.repository';
import { AuthenticationOperationService } from './operations/services/authentication-operation.service';
import { AuthenticationOperationTelemetryService } from './operations/services/authentication-operation-telemetry.service';
import { AuthenticationOperationCleanupService } from './operations/services/authentication-operation-cleanup.service';
import { AuthenticationOperationCleanupSchedulerService } from './operations/services/authentication-operation-cleanup-scheduler.service';

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
    RateLimitModule,
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
    AuthenticationRateLimitConfigService,
    AuthenticationDeliveryCooldownRepository,
    AuthenticationDeliveryRateLimitService,
    AuthenticationVerificationRateLimitService,
    AuthenticationOperationRepository,
    AuthenticationOperationService,
    AuthenticationOperationTelemetryService,
    AuthenticationOperationCleanupService,
    AuthenticationOperationCleanupSchedulerService,
    AuthenticationChallengeProofService,
    AuthenticationChallengeRandomSourceService,
    AuthenticationChallengeProofEncryptionService,
    AuthenticationChallengeProofFactoryService,
    AuthenticationChallengeRepository,
    AuthenticationChallengeRequestRepository,
    AuthenticationChallengeFinalizationRepository,
    AuthenticationChallengeRequestService,
    AuthenticationChallengeVerificationService,
    AuthenticationChallengeCleanupRepository,
    AuthenticationChallengeCleanupService,
    AuthenticationChallengeCleanupSchedulerService,
    AuthenticationDeliveryPolicyService,
    AuthenticationDeliveryRepository,
    AuthenticationDeliveryBacklogRepository,
    AuthenticationDeliveryAdmissionService,
    AuthenticationMagicLinkService,
    AuthenticationEmailTemplateService,
    AuthenticationDeliveryOrchestrationService,
    AuthenticationDeliveryRandomSourceService,
    AuthenticationDeliveryWorkerService,
    AuthenticationDeliveryCleanupRepository,
    AuthenticationDeliveryCleanupService,
    AuthenticationDeliveryCleanupSchedulerService,
    RefreshTokenGuard,
  ],
  exports: [
    AuthService,
    SessionCreationService,
    AuthenticationChallengeFinalizationRepository,
  ],
})
export class AuthModule {}
