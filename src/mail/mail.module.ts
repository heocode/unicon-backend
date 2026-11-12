// NestJS
import { Module } from '@nestjs/common';

// Internal services
import { PrismaModule } from '../prisma/prisma.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { MailSubmissionGateService } from './services/mail-submission-gate.service';
import { MailSubmissionGateConfigService } from './services/mail-submission-gate-config.service';
import { MailService } from './mail.service';
import { ResendAuthenticationEmailAdapter } from './adapters/resend-authentication-email.adapter';
import { ResendAuthenticationEmailTransportService } from './services/resend-authentication-email-transport.service';
import { AuthenticationEmailAssetService } from './services/authentication-email-asset.service';
import { AuthenticationEmailProviderPort } from '../auth/delivery/ports/authentication-email-provider.port';

@Module({
  imports: [PrismaModule, RateLimitModule],
  providers: [
    MailSubmissionGateService,
    MailSubmissionGateConfigService,
    MailService,
    ResendAuthenticationEmailTransportService,
    ResendAuthenticationEmailAdapter,
    AuthenticationEmailAssetService,
    {
      provide: AuthenticationEmailProviderPort,
      useExisting: ResendAuthenticationEmailAdapter,
    },
  ],
  exports: [
    MailSubmissionGateService,
    MailService,
    AuthenticationEmailProviderPort,
    AuthenticationEmailAssetService,
  ],
})
export class MailModule {}
