// NestJS
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Third-party
import { Resend } from 'resend';

// Internal errors
import { MailDeliveryError } from '../common/errors/mail-delivery.error';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend;
  private readonly mailFrom: string;
  private readonly clientUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(
      this.configService.getOrThrow<string>('RESEND_API_KEY'),
    );
    this.mailFrom = this.configService.getOrThrow<string>('MAIL_FROM');
    this.clientUrl = this.configService.getOrThrow<string>('CLIENT_URL');
  }

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verificationUrl = this.buildVerificationUrl(token);
    try {
      const { error } = await this.resend.emails.send({
        from: this.mailFrom,
        to: [email],
        subject: 'Verify your Unicon email',
        html: `
        <h1>Verify your email</h1>
        <p>Confirm your email address to activate your Unicon account.</p>
        <p>
          <a href="${verificationUrl}">
            Verify email
          </a>
        </p>
        <p>This verification link expires in 24 hours.</p>
      `,
      });
      if (error) {
        throw new MailDeliveryError(error.message);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send verification email to ${email}.`,
        error instanceof Error ? error.stack : undefined,
      );
      if (error instanceof MailDeliveryError) {
        throw error;
      }
      throw new MailDeliveryError();
    }
  }

  private buildVerificationUrl(token: string): string {
    const url = new URL('/verify-email', this.clientUrl);
    url.searchParams.set('token', token);

    return url.toString();
  }
}
