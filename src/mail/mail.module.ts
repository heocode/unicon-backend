// NestJS
import { Module } from '@nestjs/common';

// Internal services
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { MailSubmissionGateService } from './services/mail-submission-gate.service';
import { MailSubmissionGateConfigService } from './services/mail-submission-gate-config.service';
import { MailProviderPressureRepository } from './repositories/mail-provider-pressure.repository';
import { MailProviderPressureService } from './services/mail-provider-pressure.service';
import { ResendMailHttpClient } from './services/resend-mail-http-client.service';
import { ResendMailTransportService } from './services/resend-mail-transport.service';
import { MailService } from './mail.service';
import { ResendAuthenticationEmailAdapter } from './adapters/resend-authentication-email.adapter';
import { AuthenticationEmailAssetService } from './services/authentication-email-asset.service';
import { AuthenticationEmailProviderPort } from '../auth/delivery/ports/authentication-email-provider.port';

import { MailDeliveryRepository } from './repositories/mail-delivery.repository';
import { MailDeliveryConfigService } from './services/mail-delivery-config.service';
import { MailDeliveryEncryptionService } from './services/mail-delivery-encryption.service';
import { MailDeliveryWorkerService } from './services/mail-delivery-worker.service';

@Module({
  imports: [PrismaModule, RateLimitModule],
  providers: [
    MailDeliveryRepository,
    MailDeliveryConfigService,
    MailDeliveryEncryptionService,
    MailDeliveryWorkerService,
    MailProviderPressureRepository,
    MailProviderPressureService,
    ResendMailHttpClient,
    ResendMailTransportService,
    MailSubmissionGateService,
    MailSubmissionGateConfigService,
    MailService,
    ResendAuthenticationEmailAdapter,
    AuthenticationEmailAssetService,
    {
      provide: AuthenticationEmailProviderPort,
      useExisting: ResendAuthenticationEmailAdapter,
    },
  ],
  exports: [
    MailDeliveryWorkerService,
    MailDeliveryRepository,
    ResendMailTransportService,
    MailProviderPressureService,
    MailSubmissionGateService,
    MailService,
    AuthenticationEmailProviderPort,
    AuthenticationEmailAssetService,
  ],
})
export class MailModule {}
