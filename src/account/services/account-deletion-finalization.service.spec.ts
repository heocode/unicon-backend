import { ConfigService } from '@nestjs/config';

import { PasswordService } from '../../auth/password/services/password.service';
import { Prisma } from '../../generated/prisma/client';
import { AccountDeletionNotificationService } from '../../notifications/services/account-deletion-notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import { AccountDeletionFinalizationService } from './account-deletion-finalization.service';

describe('AccountDeletionFinalizationService', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');
  const candidate = {
    id: 'user-id',
    email: 'student@example.edu',
    deletionScheduledAt: new Date('2026-09-16T11:00:00.000Z'),
  };
  const sequence: string[] = [];
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    session: { deleteMany: jest.fn() },
    passwordResetToken: { deleteMany: jest.fn() },
    user: { updateMany: jest.fn() },
  };
  const passwordService = { hash: jest.fn() };
  const securityEventService = { record: jest.fn() };
  const notificationService = {
    prepareDeletionCompleted: jest.fn(),
    sendPreparedDeletionCompleted: jest.fn(),
    retryDeletionCompleted: jest.fn(),
  };
  const configService = { getOrThrow: jest.fn(() => 2) };

  let service: AccountDeletionFinalizationService;

  beforeEach(() => {
    jest.clearAllMocks();
    sequence.length = 0;
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: typeof prisma) => Promise<unknown>) => {
        sequence.push('transaction-start');
        const result = await callback(prisma);
        sequence.push('transaction-commit');
        return result;
      },
    );
    prisma.$queryRaw.mockResolvedValueOnce([candidate]).mockResolvedValue([]);
    prisma.session.deleteMany.mockResolvedValue({ count: 2 });
    prisma.passwordResetToken.deleteMany.mockResolvedValue({ count: 1 });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    passwordService.hash.mockResolvedValue('discarded-password-hash');
    securityEventService.record.mockResolvedValue({ id: 'deleted-event-id' });
    notificationService.prepareDeletionCompleted.mockResolvedValue({
      id: 'completion-delivery-id',
    });
    notificationService.sendPreparedDeletionCompleted.mockImplementation(() => {
      sequence.push('notification');
      return Promise.resolve(true);
    });
    notificationService.retryDeletionCompleted.mockResolvedValue(0);

    service = new AccountDeletionFinalizationService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      securityEventService as unknown as SecurityEventService,
      notificationService as unknown as AccountDeletionNotificationService,
      configService as unknown as ConfigService,
    );
  });

  it('atomically anonymizes an eligible account and notifies after commit', async () => {
    await expect(service.finalizeBatch(now)).resolves.toBe(1);

    expect(securityEventService.record).toHaveBeenCalledWith(
      {
        type: 'ACCOUNT_DELETED',
        reason: 'GRACE_PERIOD_EXPIRED',
        userId: 'user-id',
        occurredAt: now,
      },
      prisma,
    );
    expect(notificationService.prepareDeletionCompleted).toHaveBeenCalledWith(
      prisma,
      {
        userId: 'user-id',
        securityEventId: 'deleted-event-id',
        recipient: 'student@example.edu',
        occurredAt: now,
      },
    );
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
    });
    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-id' },
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
        status: 'DELETION_SCHEDULED',
        deletionScheduledAt: { lte: now },
      },
      data: {
        status: 'DELETED',
        role: 'MEMBER',
        email: 'deleted+user-id@deleted.invalid',
        username: 'deleted_user-id',
        emailVerified: false,
        passwordHash: 'discarded-password-hash',
        lastLoginAt: null,
        loginAttempts: 0,
        lockoutUntil: null,
        verificationEmailSentAt: null,
        hashedVerificationToken: null,
        verificationTokenExpires: null,
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletedAt: now,
      },
    });
    expect(sequence).toEqual([
      'transaction-start',
      'transaction-commit',
      'notification',
      'transaction-start',
      'transaction-commit',
    ]);
  });

  it('does nothing when no account has reached its deadline', async () => {
    prisma.$queryRaw.mockReset().mockResolvedValue([]);

    await expect(service.finalizeBatch(now)).resolves.toBe(0);

    expect(securityEventService.record).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(
      notificationService.sendPreparedDeletionCompleted,
    ).not.toHaveBeenCalled();
  });

  it('rolls back when the conditional terminal transition loses', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.finalizeBatch(now)).rejects.toThrow(
      'Account deletion state changed during finalization.',
    );
    expect(
      notificationService.sendPreparedDeletionCompleted,
    ).not.toHaveBeenCalled();
  });

  it('retries a serialization conflict around the entire transaction', async () => {
    prisma.$transaction
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Conflict', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      )
      .mockImplementationOnce(
        async (callback: (transaction: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );

    await expect(service.finalizeBatch(now)).resolves.toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('keeps a committed deletion successful when dispatch throws', async () => {
    notificationService.sendPreparedDeletionCompleted.mockRejectedValue(
      new Error('Notification unavailable.'),
    );

    await expect(service.finalizeBatch(now)).resolves.toBe(1);
  });

  it('retries old completion deliveries before finalizing accounts', async () => {
    prisma.$queryRaw.mockReset().mockResolvedValue([]);
    notificationService.retryDeletionCompleted.mockResolvedValue(3);

    await expect(service.run()).resolves.toEqual({
      finalizedAccounts: 0,
      retriedCompletionDeliveries: 3,
    });
    expect(notificationService.retryDeletionCompleted).toHaveBeenCalledWith(2);
  });
});
