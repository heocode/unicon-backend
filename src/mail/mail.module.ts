// NestJS
import { Module } from '@nestjs/common';

// Internal services
import { MailService } from './mail.service';
import { ResendAuthenticationEmailAdapter } from './adapters/resend-authentication-email.adapter';
import { ResendAuthenticationEmailTransportService } from './services/resend-authentication-email-transport.service';
import { AuthenticationEmailProviderPort } from '../auth/delivery/ports/authentication-email-provider.port';

@Module({
  providers: [
    MailService,
    ResendAuthenticationEmailTransportService,
    ResendAuthenticationEmailAdapter,
    {
      provide: AuthenticationEmailProviderPort,
      useExisting: ResendAuthenticationEmailAdapter,
    },
  ],
  exports: [MailService, AuthenticationEmailProviderPort],
})
export class MailModule {}
