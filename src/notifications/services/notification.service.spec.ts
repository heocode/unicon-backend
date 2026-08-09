import { MailDeliveryError } from '../../common/errors/mail-delivery.error';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from './notification.service';

describe('NotificationService', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  const session = {
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
    deviceModel: 'iPhone 16 Pro',
    platform: 'IOS' as const,
    osVersion: '18.6',
    appVersion: '1.4.2',
    locationCountryCode: 'CA',
    locationCity: 'Toronto',
    user: { email: 'student@example.edu' },
  };
  const prisma = {
    session: { findFirst: jest.fn() },
    notificationDelivery: {
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const mailService = {
    sendNewSessionEmail: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn(() => 15_552_000),
  };

  let service: NotificationService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.session.findFirst.mockResolvedValue(session);
    prisma.notificationDelivery.create.mockResolvedValue({ id: 'delivery-id' });
    prisma.notificationDelivery.update.mockResolvedValue({});
    mailService.sendNewSessionEmail.mockResolvedValue('provider-message-id');
    service = new NotificationService(
      prisma as unknown as PrismaService,
      mailService as unknown as MailService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records and sends a new-session email', async () => {
    await expect(
      service.sendNewSessionNotification('user-id', 'session-id'),
    ).resolves.toBeUndefined();

    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        type: 'NEW_SESSION',
        channel: 'EMAIL',
        userId: 'user-id',
        sessionId: 'session-id',
        recipient: 'student@example.edu',
        retentionExpiresAt: new Date('2027-02-05T12:00:00.000Z'),
      },
      select: { id: true },
    });
    expect(mailService.sendNewSessionEmail).toHaveBeenCalledWith({
      recipient: 'student@example.edu',
      idempotencyKey: 'delivery-id',
      occurredAt: session.createdAt,
      deviceModel: session.deviceModel,
      platform: session.platform,
      osVersion: session.osVersion,
      appVersion: session.appVersion,
      locationCountryCode: session.locationCountryCode,
      locationCity: session.locationCity,
    });
    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'SENT',
        providerMessageId: 'provider-message-id',
        attemptedAt: now,
        sentAt: now,
        failureCode: null,
      },
    });
  });

  it('deletes expired delivery records', async () => {
    prisma.notificationDelivery.deleteMany.mockResolvedValue({ count: 2 });

    await expect(service.deleteExpired(now)).resolves.toBe(2);
    expect(prisma.notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { retentionExpiresAt: { lte: now } },
    });
  });

  it('records a failed delivery without rejecting the auth flow', async () => {
    mailService.sendNewSessionEmail.mockRejectedValue(new MailDeliveryError());

    await expect(
      service.sendNewSessionNotification('user-id', 'session-id'),
    ).resolves.toBeUndefined();

    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'FAILED',
        attemptedAt: now,
        failureCode: 'EMAIL_DELIVERY_FAILED',
      },
    });
  });

  it('does not send when the committed session cannot be found', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await service.sendNewSessionNotification('user-id', 'session-id');

    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
    expect(mailService.sendNewSessionEmail).not.toHaveBeenCalled();
  });
});
