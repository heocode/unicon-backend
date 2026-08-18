import { ConfigService } from '@nestjs/config';

import { MailDeliveryError } from '../../common/errors/mail-delivery.error';
import { Prisma } from '../../generated/prisma/client';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountDeletionNotificationService } from './account-deletion-notification.service';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('AccountDeletionNotificationService', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const deletionScheduledAt = new Date('2026-09-16T12:00:00.000Z');
  const prisma = {
    securityEvent: { findFirst: jest.fn() },
    notificationDelivery: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };
  const mailService = {
    sendAccountDeletionRequestedEmail: jest.fn(),
    sendAccountDeletionCancelledEmail: jest.fn(),
    sendAccountDeletedEmail: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn((key: string) =>
      key === 'NOTIFICATION_DELIVERY_RETENTION_SECONDS' ? 15_552_000 : 300,
    ),
  };

  let service: AccountDeletionNotificationService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.notificationDelivery.create.mockResolvedValue({ id: 'delivery-id' });
    prisma.notificationDelivery.update.mockResolvedValue({});
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.notificationDelivery.findUnique.mockResolvedValue({
      recipient: 'student@example.edu',
      createdAt: now,
    });
    prisma.notificationDelivery.findMany.mockResolvedValue([]);
    mailService.sendAccountDeletionRequestedEmail.mockResolvedValue(
      'provider-request-id',
    );
    mailService.sendAccountDeletionCancelledEmail.mockResolvedValue(
      'provider-cancel-id',
    );
    mailService.sendAccountDeletedEmail.mockResolvedValue(
      'provider-completion-id',
    );

    service = new AccountDeletionNotificationService(
      prisma as unknown as PrismaService,
      mailService as unknown as MailService,
      new NotificationDeliveryService(
        prisma as unknown as PrismaService,
        configService as unknown as ConfigService,
      ),
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('creates and sends an idempotent deletion-request delivery', async () => {
    prisma.securityEvent.findFirst.mockResolvedValue({
      occurredAt: now,
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      locationCountryCode: 'CA',
      locationCity: 'Toronto',
      affectedSessionCount: 3,
      user: { email: 'student@example.edu' },
    });

    await service.sendDeletionRequested(
      'user-id',
      'request-event-id',
      deletionScheduledAt,
    );

    expect(prisma.securityEvent.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'request-event-id',
        userId: 'user-id',
        type: 'ACCOUNT_DELETION_REQUESTED',
      },
      select: {
        occurredAt: true,
        deviceModel: true,
        platform: true,
        locationCountryCode: true,
        locationCity: true,
        affectedSessionCount: true,
        user: { select: { email: true } },
      },
    });
    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'ACCOUNT_DELETION_REQUESTED:request-event-id',
        type: 'ACCOUNT_DELETION_REQUESTED',
        channel: 'EMAIL',
        userId: 'user-id',
        recipient: 'student@example.edu',
        retentionExpiresAt: new Date('2027-02-13T12:00:00.000Z'),
      },
      select: { id: true },
    });
    expect(mailService.sendAccountDeletionRequestedEmail).toHaveBeenCalledWith({
      recipient: 'student@example.edu',
      idempotencyKey: 'delivery-id',
      occurredAt: now,
      deletionScheduledAt,
      revokedSessionsCount: 3,
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      locationCountryCode: 'CA',
      locationCity: 'Toronto',
    });
    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'SENT',
        providerMessageId: 'provider-request-id',
        attemptedAt: now,
        sentAt: now,
        failureCode: null,
      },
    });
  });

  it('creates and sends an idempotent cancellation delivery', async () => {
    prisma.securityEvent.findFirst.mockResolvedValue({
      occurredAt: now,
      deviceModel: null,
      platform: 'WEB',
      locationCountryCode: null,
      locationCity: null,
      user: { email: 'student@example.edu' },
    });

    await service.sendDeletionCancelled('user-id', 'cancel-event-id');

    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'ACCOUNT_DELETION_CANCELLED:cancel-event-id',
        type: 'ACCOUNT_DELETION_CANCELLED',
        channel: 'EMAIL',
        userId: 'user-id',
        recipient: 'student@example.edu',
        retentionExpiresAt: new Date('2027-02-13T12:00:00.000Z'),
      },
      select: { id: true },
    });
    expect(mailService.sendAccountDeletionCancelledEmail).toHaveBeenCalledWith({
      recipient: 'student@example.edu',
      idempotencyKey: 'delivery-id',
      occurredAt: now,
      deviceModel: null,
      platform: 'WEB',
      locationCountryCode: null,
      locationCity: null,
    });
  });

  it('does not duplicate a delivery when its idempotency key exists', async () => {
    prisma.securityEvent.findFirst.mockResolvedValue({
      occurredAt: now,
      deviceModel: null,
      platform: null,
      locationCountryCode: null,
      locationCity: null,
      user: { email: 'student@example.edu' },
    });
    prisma.notificationDelivery.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique conflict', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );

    await expect(
      service.sendDeletionCancelled('user-id', 'cancel-event-id'),
    ).resolves.toBeUndefined();
    expect(
      mailService.sendAccountDeletionCancelledEmail,
    ).not.toHaveBeenCalled();
  });

  it('records provider failure without rejecting the lifecycle flow', async () => {
    prisma.securityEvent.findFirst.mockResolvedValue({
      occurredAt: now,
      deviceModel: null,
      platform: null,
      locationCountryCode: null,
      locationCity: null,
      user: { email: 'student@example.edu' },
    });
    mailService.sendAccountDeletionCancelledEmail.mockRejectedValue(
      new MailDeliveryError(),
    );

    await expect(
      service.sendDeletionCancelled('user-id', 'cancel-event-id'),
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

  it('does not create a delivery when the committed event is unavailable', async () => {
    prisma.securityEvent.findFirst.mockResolvedValue(null);

    await service.sendDeletionRequested(
      'user-id',
      'missing-event-id',
      deletionScheduledAt,
    );

    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('prepares the completion recipient inside the caller transaction', async () => {
    await expect(
      service.prepareDeletionCompleted(
        prisma as unknown as Prisma.TransactionClient,
        {
          userId: 'user-id',
          securityEventId: 'deleted-event-id',
          recipient: 'student@example.edu',
          occurredAt: now,
        },
      ),
    ).resolves.toEqual({ id: 'delivery-id' });

    expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'ACCOUNT_DELETED:deleted-event-id',
        type: 'ACCOUNT_DELETED',
        channel: 'EMAIL',
        userId: 'user-id',
        recipient: 'student@example.edu',
        createdAt: now,
        retentionExpiresAt: new Date('2027-02-13T12:00:00.000Z'),
      },
      select: { id: true },
    });
  });

  it('claims and sends a prepared completion delivery', async () => {
    await expect(
      service.sendPreparedDeletionCompleted('delivery-id'),
    ).resolves.toBe(true);

    expect(prisma.notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'delivery-id',
        type: 'ACCOUNT_DELETED',
        status: { in: ['PENDING', 'FAILED'] },
        OR: [
          { attemptedAt: null },
          { attemptedAt: { lte: new Date('2026-08-17T11:55:00.000Z') } },
        ],
      },
      data: { attemptedAt: now },
    });
    expect(mailService.sendAccountDeletedEmail).toHaveBeenCalledWith({
      recipient: 'student@example.edu',
      idempotencyKey: 'delivery-id',
      occurredAt: now,
    });
    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'SENT',
        providerMessageId: 'provider-completion-id',
        attemptedAt: now,
        sentAt: now,
        failureCode: null,
      },
    });
  });

  it('does not send a completion delivery claimed by another worker', async () => {
    prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.sendPreparedDeletionCompleted('delivery-id'),
    ).resolves.toBe(false);
    expect(prisma.notificationDelivery.findUnique).not.toHaveBeenCalled();
    expect(mailService.sendAccountDeletedEmail).not.toHaveBeenCalled();
  });

  it('keeps a failed completion delivery retryable', async () => {
    mailService.sendAccountDeletedEmail.mockRejectedValue(
      new MailDeliveryError(),
    );

    await expect(
      service.sendPreparedDeletionCompleted('delivery-id'),
    ).resolves.toBe(true);
    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'FAILED',
        attemptedAt: now,
        failureCode: 'EMAIL_DELIVERY_FAILED',
      },
    });
  });
});
