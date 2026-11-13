import type { Prisma } from '../../generated/prisma/client';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountDeletionNotificationService } from './account-deletion-notification.service';

describe('AccountDeletionNotificationService queue ownership', () => {
  const event = {
    occurredAt: new Date('2026-08-17T12:00:00Z'),
    deviceModel: null,
    platform: null,
    locationCountryCode: null,
    locationCity: null,
    affectedSessionCount: 2,
    user: { email: 'student@example.edu' },
  };
  const prisma = { securityEvent: { findFirst: jest.fn() } };
  const mail = {
    sendAccountDeletionRequestedEmail: jest.fn(),
    sendAccountDeletionCancelledEmail: jest.fn(),
    sendAccountDeletedEmail: jest.fn(),
  };
  let service: AccountDeletionNotificationService;
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.securityEvent.findFirst.mockResolvedValue(event);
    mail.sendAccountDeletedEmail.mockResolvedValue('durable-job-id');
    service = new AccountDeletionNotificationService(
      prisma as unknown as PrismaService,
      mail as unknown as MailService,
    );
  });
  it('queues owned deletion events using stable keys', async () => {
    await service.sendDeletionRequested('user-id', 'event-id', new Date());
    expect(prisma.securityEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'event-id',
          userId: 'user-id',
          type: 'ACCOUNT_DELETION_REQUESTED',
        },
      }),
    );
    expect(mail.sendAccountDeletionRequestedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'ACCOUNT_DELETION_REQUESTED:event-id',
        recipient: event.user.email,
      }),
      { userId: 'user-id' },
    );
  });
  it('prepares a complete immutable completion job in the caller transaction', async () => {
    const tx = {} as Prisma.TransactionClient;
    expect(
      await service.prepareDeletionCompleted(tx, {
        userId: 'user-id',
        securityEventId: 'event-id',
        recipient: event.user.email,
        occurredAt: event.occurredAt,
      }),
    ).toEqual({ id: 'durable-job-id' });
    expect(mail.sendAccountDeletedEmail).toHaveBeenCalledWith(
      {
        recipient: event.user.email,
        idempotencyKey: 'ACCOUNT_DELETED:event-id',
        occurredAt: event.occurredAt,
      },
      { userId: 'user-id' },
      tx,
    );
  });
  it('propagates completion enqueue failure so finalization can roll back', async () => {
    mail.sendAccountDeletedEmail.mockRejectedValueOnce(
      new Error('enqueue unavailable'),
    );
    await expect(
      service.prepareDeletionCompleted({} as Prisma.TransactionClient, {
        userId: 'user-id',
        securityEventId: 'event-id',
        recipient: event.user.email,
        occurredAt: event.occurredAt,
      }),
    ).rejects.toThrow('enqueue unavailable');
  });
});
