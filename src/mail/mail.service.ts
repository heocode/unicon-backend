// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Third-party
import { createHash } from 'node:crypto';

import type { NotificationType } from '../generated/prisma/client';
import { MailDeliveryRepository } from './repositories/mail-delivery.repository';
import type {
  MailDeliveryContext,
  MailProofGuard,
  MailTransaction,
  QueueMailInput,
} from './types/mail-delivery.type';

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
  private readonly mailFrom: string;
  private readonly clientUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly delivery: MailDeliveryRepository,
  ) {
    this.mailFrom = this.configService.getOrThrow<string>('MAIL_FROM');
    this.clientUrl = this.configService.getOrThrow<string>('CLIENT_URL');
  }

  async sendVerificationEmail(
    email: string,
    token: string,
    userId: string,
  ): Promise<string> {
    const verificationUrl = this.buildVerificationUrl(token);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return this.queueEmail(
      'LEGACY_EMAIL_VERIFICATION',
      `LEGACY_EMAIL_VERIFICATION:${userId}:${tokenHash}`,
      {
        from: this.mailFrom,
        recipient: email,
        subject: 'Verify your Unicon email',
        html: `
        <h1>Verify your email</h1>
        <p>Confirm your email address to activate your Unicon account.</p>
        <p><a href="${verificationUrl}">Verify email</a></p>
        <p>This verification link expires in 24 hours.</p>
      `,
        text: `Confirm your email address: ${verificationUrl}`,
      },
      { userId },
      { kind: 'VERIFICATION', userId, tokenHash },
    );
  }

  async sendNewSessionEmail(
    notification: NewSessionEmail,
    context: MailDeliveryContext = {},
  ): Promise<string> {
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

    return this.queueEmail(
      'NEW_SESSION',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
        subject: 'New sign-in to your Unicon account',
        text: [
          'A new session was created for your Unicon account.',
          '',
          ...details,
          '',
          'If this was not you, review and revoke the session in your account settings.',
        ].join('\n'),
      },
      context,
    );
  }

  async sendSuspiciousActivityEmail(
    notification: NewSessionEmail,
    context: MailDeliveryContext = {},
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

    return this.queueEmail(
      'SUSPICIOUS_ACTIVITY',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
        subject: 'Suspicious activity on your Unicon account',
        text: [
          'We detected unusual security activity on your Unicon account.',
          '',
          ...details,
          '',
          'If this was not you, review and revoke your active sessions immediately.',
        ].join('\n'),
      },
      context,
    );
  }

  async sendPasswordChangedEmail(
    notification: PasswordChangedEmail,
    context: MailDeliveryContext = {},
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

    return this.queueEmail(
      'PASSWORD_CHANGED',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
        subject: 'Your Unicon password was changed',
        text: [
          'The password for your Unicon account was changed.',
          '',
          ...details,
          '',
          'If this was not you, contact Unicon support immediately.',
        ].join('\n'),
      },
      context,
    );
  }

  async sendAccountDeletionRequestedEmail(
    notification: AccountDeletionRequestedEmail,
    context: MailDeliveryContext = {},
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

    return this.queueEmail(
      'ACCOUNT_DELETION_REQUESTED',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
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
      context,
    );
  }

  async sendAccountDeletionCancelledEmail(
    notification: AccountDeletionCancelledEmail,
    context: MailDeliveryContext = {},
  ): Promise<string> {
    const details = [
      `Cancelled at: ${notification.occurredAt.toISOString()}`,
      notification.platform ? `Platform: ${notification.platform}` : undefined,
      notification.deviceModel
        ? `Device: ${notification.deviceModel}`
        : undefined,
      this.formatLocation(notification),
    ].filter((line): line is string => Boolean(line));

    return this.queueEmail(
      'ACCOUNT_DELETION_CANCELLED',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
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
      context,
    );
  }

  async sendAccountDeletedEmail(
    notification: AccountDeletedEmail,
    context: MailDeliveryContext = {},
    transaction?: MailTransaction,
  ): Promise<string> {
    return this.queueEmail(
      'ACCOUNT_DELETED',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
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
      context,
      undefined,
      transaction,
    );
  }

  async sendPasswordResetRequestEmail(
    notification: PasswordResetRequestEmail,
    context: MailDeliveryContext = {},
  ): Promise<string> {
    const url = new URL('/reset-password', this.clientUrl);
    url.searchParams.set('token', notification.token);

    return this.queueEmail(
      'PASSWORD_RESET_REQUEST',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
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
      context,
      {
        kind: 'PASSWORD_RESET',
        tokenId: notification.tokenId,
        userId: notification.userId,
        tokenHash: createHash('sha256')
          .update(notification.token)
          .digest('hex'),
      },
    );
  }

  async sendPasswordResetCompletedEmail(
    notification: PasswordResetCompletedEmail,
    context: MailDeliveryContext = {},
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

    return this.queueEmail(
      'PASSWORD_RESET_COMPLETED',
      notification.idempotencyKey,
      {
        from: this.mailFrom,
        recipient: notification.recipient,
        subject: 'Your Unicon password was reset',
        text: [
          'The password for your Unicon account was reset.',
          '',
          ...details,
          '',
          'If this was not you, contact Unicon support immediately.',
        ].join('\n'),
      },
      context,
    );
  }

  // Returns a durable job ID, never a provider acceptance ID.
  private async queueEmail(
    type: NotificationType,
    idempotencyKey: string,
    content: QueueMailInput['content'],
    context: MailDeliveryContext,
    guard?: MailProofGuard,
    transaction?: MailTransaction,
  ): Promise<string> {
    try {
      return await this.delivery.enqueue(
        {
          type,
          idempotencyKey,
          content,
          ...context,
          ...(guard ? { guard } : {}),
        },
        transaction,
      );
    } catch {
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
