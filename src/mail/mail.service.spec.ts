import { ConfigService } from '@nestjs/config';

import { MailDeliveryError } from '../common/errors/mail-delivery.error';
import type {
  MailTransaction,
  QueueMailInput,
} from './types/mail-delivery.type';
import { MailDeliveryRepository } from './repositories/mail-delivery.repository';
import { MailService } from './mail.service';

describe('MailService durable rendering', () => {
  const enqueue = jest.fn<
    Promise<string>,
    [QueueMailInput, MailTransaction?]
  >();
  let service: MailService;
  const notification = {
    recipient: 'student@example.edu',
    idempotencyKey: 'NEW_SESSION:session-id',
    occurredAt: new Date('2026-08-09T12:00:00Z'),
    deviceModel: 'iPhone',
    platform: 'IOS' as const,
    osVersion: '18',
    appVersion: '1',
    locationCountryCode: 'CA',
    locationCity: 'Toronto',
    riskLevel: 'HIGH' as const,
    riskSignals: ['NEW_COUNTRY' as const],
  };
  beforeEach(() => {
    enqueue.mockReset().mockResolvedValue('job-id');
    service = new MailService(
      new ConfigService({
        MAIL_FROM: 'Unicon <test@example.edu>',
        CLIENT_URL: 'https://example.edu',
      }),
      { enqueue } as unknown as MailDeliveryRepository,
    );
  });
  it('renders stable content and returns the durable job ID without claiming provider acceptance', async () => {
    expect(
      await service.sendNewSessionEmail(notification, {
        userId: 'user-id',
        sessionId: 'session-id',
      }),
    ).toBe('job-id');
    const first: unknown = enqueue.mock.calls[0][0];
    await service.sendNewSessionEmail(notification, {
      userId: 'user-id',
      sessionId: 'session-id',
    });
    expect(enqueue.mock.calls[1][0]).toEqual(first);
    expect(first).toMatchObject({
      type: 'NEW_SESSION',
      idempotencyKey: notification.idempotencyKey,
      userId: 'user-id',
      sessionId: 'session-id',
      content: {
        recipient: notification.recipient,
        from: 'Unicon <test@example.edu>',
        text: expect.stringContaining(
          'Approximate location: Toronto, CA',
        ) as string,
      },
    });
  });
  it('binds legacy verification to a hashed proof guard, never to a raw-token idempotency key', async () => {
    await service.sendVerificationEmail(
      notification.recipient,
      'temporary-proof',
      'user-id',
    );
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      type: 'LEGACY_EMAIL_VERIFICATION',
      guard: { kind: 'VERIFICATION', userId: 'user-id' },
    });
    const queued = enqueue.mock.calls[0][0] as {
      idempotencyKey: string;
      guard: { tokenHash: string };
    };
    expect(queued.idempotencyKey).not.toContain('temporary-proof');
    expect(queued.guard.tokenHash).toHaveLength(64);
  });
  it('sanitizes enqueue failures without retaining a provider/database cause', async () => {
    enqueue.mockRejectedValue(new Error('private connection string'));
    await expect(
      service.sendNewSessionEmail(notification),
    ).rejects.toBeInstanceOf(MailDeliveryError);
    await expect(
      service.sendNewSessionEmail(notification),
    ).rejects.not.toHaveProperty('cause');
  });
});
