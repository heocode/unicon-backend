// NestJS
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Third-party
import { Resend } from 'resend';

// Internal errors
import { MailDeliveryError } from '../common/errors/mail-delivery.error';

// Internal types
import type { NewSessionEmail } from './types/new-session-email.type';
import type { PasswordChangedEmail } from './types/password-changed-email.type';

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

  async sendNewSessionEmail(notification: NewSessionEmail): Promise<string> {
    const details = [
      `Time: ${notification.occurredAt.toISOString()}`,
      `Platform: ${notification.platform}`,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      notification.osVersion
        ? `OS version: ${notification.osVersion}`
        : undefined,
      notification.appVersion
        ? `App version: ${notification.appVersion}`
        : undefined,
      this.formatLocation(notification),
      ...this.formatRiskDetails(notification),
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'New sign-in to your Unicon account',
          text: [
            'A new session was created for your Unicon account.',
            '',
            ...details,
            '',
            'If this was not you, review and revoke the session in your account settings.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) {
        throw new MailDeliveryError(error?.message);
      }

      return data.id;
    } catch (error) {
      this.logger.error(
        `Failed to send a new-session email to ${notification.recipient}.`,
        error instanceof Error ? error.stack : undefined,
      );

      if (error instanceof MailDeliveryError) {
        throw error;
      }

      throw new MailDeliveryError();
    }
  }

  async sendSuspiciousActivityEmail(
    notification: NewSessionEmail,
  ): Promise<string> {
    const details = [
      `Time: ${notification.occurredAt.toISOString()}`,
      `Platform: ${notification.platform}`,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      this.formatLocation(notification),
      ...this.formatRiskDetails(notification),
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Suspicious activity on your Unicon account',
          text: [
            'We detected unusual security activity on your Unicon account.',
            '',
            ...details,
            '',
            'If this was not you, review and revoke your active sessions immediately.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) {
        throw new MailDeliveryError(error?.message);
      }

      return data.id;
    } catch (error) {
      this.logger.error(
        `Failed to send a suspicious-activity email to ${notification.recipient}.`,
        error instanceof Error ? error.stack : undefined,
      );

      if (error instanceof MailDeliveryError) {
        throw error;
      }

      throw new MailDeliveryError();
    }
  }

  async sendPasswordChangedEmail(
    notification: PasswordChangedEmail,
  ): Promise<string> {
    const details = [
      `Time: ${notification.occurredAt.toISOString()}`,
      notification.platform ? `Platform: ${notification.platform}` : undefined,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      notification.osVersion
        ? `OS version: ${notification.osVersion}`
        : undefined,
      notification.appVersion
        ? `App version: ${notification.appVersion}`
        : undefined,
      this.formatLocation(notification),
      `Other sessions signed out: ${notification.revokedSessionsCount}`,
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Your Unicon password was changed',
          text: [
            'The password for your Unicon account was changed.',
            '',
            ...details,
            '',
            'If this was not you, contact Unicon support immediately.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) {
        throw new MailDeliveryError(error?.message);
      }

      return data.id;
    } catch (error) {
      this.logger.error(
        `Failed to send a password-change email to ${notification.recipient}.`,
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

  private formatLocation(notification: {
    locationCountryCode: string | null;
    locationCity: string | null;
  }): string | undefined {
    if (!notification.locationCountryCode) {
      return undefined;
    }

    const location = notification.locationCity
      ? `${notification.locationCity}, ${notification.locationCountryCode}`
      : notification.locationCountryCode;

    return `Approximate location: ${location}`;
  }

  private formatRiskDetails(notification: NewSessionEmail): string[] {
    if (!notification.riskLevel || notification.riskSignals.length === 0) {
      return [];
    }

    return [
      `Risk level: ${notification.riskLevel}`,
      ...notification.riskSignals.map(
        (signal) => `Security signal: ${this.formatRiskSignal(signal)}`,
      ),
    ];
  }

  private formatRiskSignal(
    signal: NewSessionEmail['riskSignals'][number],
  ): string {
    const labels: Record<NewSessionEmail['riskSignals'][number], string> = {
      NEW_DEVICE: 'New device',
      NEW_COUNTRY: 'New country',
      EXCESSIVE_LOGIN_FAILURES: 'Several failed sign-in attempts',
      MANY_NEW_SESSIONS: 'Several sessions created recently',
      REFRESH_TOKEN_REUSE: 'A refresh token was reused',
    };

    return labels[signal];
  }
}
