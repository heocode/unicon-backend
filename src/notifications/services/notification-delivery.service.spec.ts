import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const notificationDelivery = {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = { notificationDelivery };
  const configService = { getOrThrow: jest.fn(() => 15_552_000) };

  let service: NotificationDeliveryService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    notificationDelivery.create.mockResolvedValue({ id: 'delivery-id' });
    notificationDelivery.update.mockResolvedValue({});
    notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
    notificationDelivery.findMany.mockResolvedValue([
      { id: 'delivery-1' },
      { id: 'delivery-2' },
    ]);
    notificationDelivery.findUnique.mockResolvedValue({
      recipient: 'student@example.edu',
      createdAt: now,
    });
    notificationDelivery.deleteMany.mockResolvedValue({ count: 2 });

    service = new NotificationDeliveryService(
      prisma as unknown as PrismaService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('creates a retained pending email delivery', async () => {
    await expect(
      service.createIdempotent({
        idempotencyKey: 'NEW_SESSION:session-id',
        type: 'NEW_SESSION',
        userId: 'user-id',
        sessionId: 'session-id',
        recipient: 'student@example.edu',
      }),
    ).resolves.toEqual({ id: 'delivery-id' });

    expect(notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'NEW_SESSION:session-id',
        type: 'NEW_SESSION',
        channel: 'EMAIL',
        userId: 'user-id',
        sessionId: 'session-id',
        recipient: 'student@example.edu',
        retentionExpiresAt: new Date('2027-02-13T12:00:00.000Z'),
      },
      select: { id: true },
    });
  });

  it('uses the supplied transaction and creation timestamp', async () => {
    const transaction = { notificationDelivery: { create: jest.fn() } };
    transaction.notificationDelivery.create.mockResolvedValue({
      id: 'transactional-delivery-id',
    });
    const createdAt = new Date('2026-09-16T12:00:00.000Z');

    await expect(
      service.createIdempotent(
        {
          idempotencyKey: 'ACCOUNT_DELETED:event-id',
          type: 'ACCOUNT_DELETED',
          userId: 'user-id',
          recipient: 'student@example.edu',
          createdAt,
        },
        transaction as unknown as Prisma.TransactionClient,
      ),
    ).resolves.toEqual({ id: 'transactional-delivery-id' });
    expect(transaction.notificationDelivery.create).toHaveBeenCalledWith({
      data: {
        idempotencyKey: 'ACCOUNT_DELETED:event-id',
        type: 'ACCOUNT_DELETED',
        channel: 'EMAIL',
        userId: 'user-id',
        sessionId: undefined,
        recipient: 'student@example.edu',
        createdAt,
        retentionExpiresAt: new Date('2027-03-15T12:00:00.000Z'),
      },
      select: { id: true },
    });
  });

  it('normalizes a duplicate idempotency key to null', async () => {
    notificationDelivery.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique conflict', {
        code: 'P2002',
        clientVersion: '7.8.0',
      }),
    );

    await expect(
      service.createIdempotent({
        idempotencyKey: 'NEW_SESSION:session-id',
        type: 'NEW_SESSION',
        recipient: 'student@example.edu',
      }),
    ).resolves.toBeNull();
  });

  it('does not hide unexpected database errors', async () => {
    notificationDelivery.create.mockRejectedValue(new Error('Database down'));

    await expect(
      service.createIdempotent({
        idempotencyKey: 'NEW_SESSION:session-id',
        type: 'NEW_SESSION',
        recipient: 'student@example.edu',
      }),
    ).rejects.toThrow('Database down');
  });

  it('marks a delivery sent', async () => {
    await service.markSent({
      deliveryId: 'delivery-id',
      providerMessageId: 'provider-id',
      attemptedAt: now,
    });

    expect(notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'SENT',
        providerMessageId: 'provider-id',
        attemptedAt: now,
        sentAt: now,
        failureCode: null,
      },
    });
  });

  it('marks a delivery failed', async () => {
    await service.markFailed({
      deliveryId: 'delivery-id',
      attemptedAt: now,
      failureCode: 'EMAIL_DELIVERY_FAILED',
    });

    expect(notificationDelivery.update).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      data: {
        status: 'FAILED',
        attemptedAt: now,
        failureCode: 'EMAIL_DELIVERY_FAILED',
      },
    });
  });

  it('atomically claims a retryable delivery', async () => {
    const retryBefore = new Date('2026-08-17T11:55:00.000Z');

    await expect(
      service.claimRetryable({
        deliveryId: 'delivery-id',
        type: 'ACCOUNT_DELETED',
        attemptedAt: now,
        retryBefore,
      }),
    ).resolves.toBe(true);
    expect(notificationDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'delivery-id',
        type: 'ACCOUNT_DELETED',
        status: { in: ['PENDING', 'FAILED'] },
        OR: [{ attemptedAt: null }, { attemptedAt: { lte: retryBefore } }],
      },
      data: { attemptedAt: now },
    });
  });

  it('reports a lost retry claim', async () => {
    notificationDelivery.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.claimRetryable({
        deliveryId: 'delivery-id',
        type: 'ACCOUNT_DELETED',
        attemptedAt: now,
        retryBefore: now,
      }),
    ).resolves.toBe(false);
  });

  it('finds retryable delivery IDs in stable order', async () => {
    const retryBefore = new Date('2026-08-17T11:55:00.000Z');

    await expect(
      service.findRetryableIds({
        type: 'ACCOUNT_DELETED',
        retryBefore,
        limit: 100,
      }),
    ).resolves.toEqual(['delivery-1', 'delivery-2']);
    expect(notificationDelivery.findMany).toHaveBeenCalledWith({
      where: {
        type: 'ACCOUNT_DELETED',
        status: { in: ['PENDING', 'FAILED'] },
        OR: [{ attemptedAt: null }, { attemptedAt: { lte: retryBefore } }],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  });

  it('reads the retained recipient snapshot', async () => {
    await expect(service.findRecipientSnapshot('delivery-id')).resolves.toEqual(
      {
        recipient: 'student@example.edu',
        createdAt: now,
      },
    );
    expect(notificationDelivery.findUnique).toHaveBeenCalledWith({
      where: { id: 'delivery-id' },
      select: { recipient: true, createdAt: true },
    });
  });

  it('deletes expired delivery records', async () => {
    await expect(service.deleteExpired(now)).resolves.toBe(2);
    expect(notificationDelivery.deleteMany).toHaveBeenCalledWith({
      where: { retentionExpiresAt: { lte: now } },
    });
  });
});
