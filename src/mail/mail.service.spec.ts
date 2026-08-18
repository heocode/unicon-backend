import { ConfigService } from '@nestjs/config';

import { MailDeliveryError } from '../common/errors/mail-delivery.error';
import { MailService } from './mail.service';

describe('MailService new-session email', () => {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        RESEND_API_KEY: 'test-api-key',
        MAIL_FROM: 'Unicon <test@unicon.local>',
        CLIENT_URL: 'http://localhost:3001',
      };

      return values[key];
    }),
  };
  const send = jest.fn();

  let service: MailService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MailService(configService as unknown as ConfigService);
    Object.defineProperty(service, 'resend', {
      value: { emails: { send } },
    });
  });

  it('sends a plain-text session notification with an idempotency key', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });

    await expect(
      service.sendNewSessionEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-08-09T12:00:00.000Z'),
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        osVersion: '18.6',
        appVersion: '1.4.2',
        locationCountryCode: 'CA',
        locationCity: 'Toronto',
        riskLevel: 'MEDIUM',
        riskSignals: ['NEW_DEVICE', 'NEW_COUNTRY'],
      }),
    ).resolves.toBe('provider-id');

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Unicon <test@unicon.local>',
        to: ['student@example.edu'],
        subject: 'New sign-in to your Unicon account',
        text: [
          'A new session was created for your Unicon account.',
          '',
          'Time: 2026-08-09T12:00:00.000Z',
          'Platform: IOS',
          'Device: iPhone 16 Pro',
          'OS version: 18.6',
          'App version: 1.4.2',
          'Approximate location: Toronto, CA',
          'Risk level: MEDIUM',
          'Security signal: New device',
          'Security signal: New country',
          '',
          'If this was not you, review and revoke the session in your account settings.',
        ].join('\n'),
      },
      { idempotencyKey: 'delivery-id' },
    );
  });

  it('normalizes provider failures', async () => {
    send.mockResolvedValue({
      data: null,
      error: { message: 'Provider unavailable.' },
    });

    await expect(
      service.sendNewSessionEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-08-09T12:00:00.000Z'),
        deviceModel: null,
        platform: 'WEB',
        osVersion: null,
        appVersion: null,
        locationCountryCode: null,
        locationCity: null,
        riskLevel: null,
        riskSignals: [],
      }),
    ).rejects.toBeInstanceOf(MailDeliveryError);
  });

  it('sends a plain-text password-change notification', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });

    await expect(
      service.sendPasswordChangedEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-08-16T12:00:00.000Z'),
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        osVersion: '18.6',
        appVersion: '1.4.2',
        locationCountryCode: 'CA',
        locationCity: 'Toronto',
        revokedSessionsCount: 2,
      }),
    ).resolves.toBe('provider-id');

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Unicon <test@unicon.local>',
        to: ['student@example.edu'],
        subject: 'Your Unicon password was changed',
        text: [
          'The password for your Unicon account was changed.',
          '',
          'Time: 2026-08-16T12:00:00.000Z',
          'Platform: IOS',
          'Device: iPhone 16 Pro',
          'OS version: 18.6',
          'App version: 1.4.2',
          'Approximate location: Toronto, CA',
          'Other sessions signed out: 2',
          '',
          'If this was not you, contact Unicon support immediately.',
        ].join('\n'),
      },
      { idempotencyKey: 'delivery-id' },
    );
  });

  it('sends a deletion-request notification with its deadline', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });

    await expect(
      service.sendAccountDeletionRequestedEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-08-17T12:00:00.000Z'),
        deletionScheduledAt: new Date('2026-09-16T12:00:00.000Z'),
        revokedSessionsCount: 3,
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        locationCountryCode: 'CA',
        locationCity: 'Toronto',
      }),
    ).resolves.toBe('provider-id');

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Unicon <test@unicon.local>',
        to: ['student@example.edu'],
        subject: 'Your Unicon account is scheduled for deletion',
        text: [
          'Deletion was requested for your Unicon account.',
          '',
          'Requested at: 2026-08-17T12:00:00.000Z',
          'Scheduled deletion date: 2026-09-16T12:00:00.000Z',
          'Platform: IOS',
          'Device: iPhone 16 Pro',
          'Approximate location: Toronto, CA',
          'Sessions signed out: 3',
          '',
          'All existing sessions were signed out immediately.',
          'You can cancel deletion in the Unicon app before the scheduled deletion date by confirming your email and current password.',
          'If this was not you, cancel deletion and change your password immediately.',
        ].join('\n'),
      },
      { idempotencyKey: 'delivery-id' },
    );
  });

  it('sends a deletion-cancellation notification', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });

    await expect(
      service.sendAccountDeletionCancelledEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-08-17T12:00:00.000Z'),
        deviceModel: null,
        platform: 'WEB',
        locationCountryCode: null,
        locationCity: null,
      }),
    ).resolves.toBe('provider-id');

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Unicon <test@unicon.local>',
        to: ['student@example.edu'],
        subject: 'Your Unicon account deletion was cancelled',
        text: [
          'Deletion of your Unicon account was cancelled.',
          '',
          'Cancelled at: 2026-08-17T12:00:00.000Z',
          'Platform: WEB',
          '',
          'A new session was created. Previously revoked sessions and tokens remain invalid.',
          'If this was not you, change your password immediately.',
        ].join('\n'),
      },
      { idempotencyKey: 'delivery-id' },
    );
  });

  it('sends a completed-deletion notification to the retained recipient', async () => {
    send.mockResolvedValue({ data: { id: 'provider-id' }, error: null });

    await expect(
      service.sendAccountDeletedEmail({
        recipient: 'student@example.edu',
        idempotencyKey: 'delivery-id',
        occurredAt: new Date('2026-09-16T12:00:00.000Z'),
      }),
    ).resolves.toBe('provider-id');

    expect(send).toHaveBeenCalledWith(
      {
        from: 'Unicon <test@unicon.local>',
        to: ['student@example.edu'],
        subject: 'Your Unicon account was deleted',
        text: [
          'Your Unicon account was permanently deleted and its identifying information was anonymized.',
          '',
          'Completed at: 2026-09-16T12:00:00.000Z',
          '',
          'The deleted account cannot be restored.',
          'You may register the same email address again, but it will create a new account and require email verification.',
        ].join('\n'),
      },
      { idempotencyKey: 'delivery-id' },
    );
  });
});
