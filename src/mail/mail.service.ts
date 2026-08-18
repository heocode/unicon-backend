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
import type {
  AccountDeletionCancelledEmail,
  AccountDeletedEmail,
  AccountDeletionRequestedEmail,
} from './types/account-deletion-email.type';
import type {
  PasswordResetCompletedEmail,
  PasswordResetRequestEmail,
} from './types/password-reset-email.type';

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

  async sendAccountDeletionRequestedEmail(
    notification: AccountDeletionRequestedEmail,
  ): Promise<string> {
    const details = [
      `Requested at: ${notification.occurredAt.toISOString()}`,
      `Scheduled deletion date: ${notification.deletionScheduledAt.toISOString()}`,
      notification.platform ? `Platform: ${notification.platform}` : undefined,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      this.formatLocation(notification),
      `Sessions signed out: ${notification.revokedSessionsCount}`,
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Your Unicon account is scheduled for deletion',
          text: [
            'Deletion was requested for your Unicon account.',
            '',
            ...details,
            '',
            'All existing sessions were signed out immediately.',
            'You can cancel deletion in the Unicon app before the scheduled deletion date by confirming your email and current password.',
            'If this was not you, cancel deletion and change your password immediately.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) throw new MailDeliveryError(error?.message);
      return data.id;
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      throw new MailDeliveryError();
    }
  }

  async sendAccountDeletionCancelledEmail(
    notification: AccountDeletionCancelledEmail,
  ): Promise<string> {
    const details = [
      `Cancelled at: ${notification.occurredAt.toISOString()}`,
      notification.platform ? `Platform: ${notification.platform}` : undefined,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      this.formatLocation(notification),
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Your Unicon account deletion was cancelled',
          text: [
            'Deletion of your Unicon account was cancelled.',
            '',
            ...details,
            '',
            'A new session was created. Previously revoked sessions and tokens remain invalid.',
            'If this was not you, change your password immediately.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) throw new MailDeliveryError(error?.message);
      return data.id;
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      throw new MailDeliveryError();
    }
  }

  async sendAccountDeletedEmail(
    notification: AccountDeletedEmail,
  ): Promise<string> {
    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Your Unicon account was deleted',
          text: [
            'Your Unicon account was permanently deleted and its identifying information was anonymized.',
            '',
            `Completed at: ${notification.occurredAt.toISOString()}`,
            '',
            'The deleted account cannot be restored.',
            'You may register the same email address again, but it will create a new account and require email verification.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );

      if (error || !data) throw new MailDeliveryError(error?.message);
      return data.id;
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      throw new MailDeliveryError();
    }
  }

  async sendPasswordResetRequestEmail(
    notification: PasswordResetRequestEmail,
  ): Promise<string> {
    const url = new URL('/reset-password', this.clientUrl);
    url.searchParams.set('token', notification.token);

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Reset your Unicon password',
          text: [
            'A password reset was requested for your Unicon account.',
            '',
            url.toString(),
            '',
            `This link expires in ${Math.ceil(notification.expiresInSeconds / 60)} minutes.`,
            'If this was not you, you can ignore this email.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );
      if (error || !data) throw new MailDeliveryError(error?.message);
      return data.id;
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
      throw new MailDeliveryError();
    }
  }

  async sendPasswordResetCompletedEmail(
    notification: PasswordResetCompletedEmail,
  ): Promise<string> {
    const details = [
      `Time: ${notification.occurredAt.toISOString()}`,
      notification.platform ? `Platform: ${notification.platform}` : undefined,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      this.formatLocation(notification),
      `Sessions signed out: ${notification.revokedSessionsCount}`,
    ].filter((line): line is string => Boolean(line));

    try {
      const { data, error } = await this.resend.emails.send(
        {
          from: this.mailFrom,
          to: [notification.recipient],
          subject: 'Your Unicon password was reset',
          text: [
            'The password for your Unicon account was reset.',
            '',
            ...details,
            '',
            'If this was not you, contact Unicon support immediately.',
          ].join('\n'),
        },
        { idempotencyKey: notification.idempotencyKey },
      );
      if (error || !data) throw new MailDeliveryError(error?.message);
      return data.id;
    } catch (error) {
      if (error instanceof MailDeliveryError) throw error;
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
