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
      }),
    ).rejects.toBeInstanceOf(MailDeliveryError);
  });
});
