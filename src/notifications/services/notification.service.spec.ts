import { Logger } from '@nestjs/common';

import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationService } from './notification.service';

describe('NotificationService queue boundary', () => {
  const session = {
    createdAt: new Date('2026-08-09T12:00:00Z'),
    deviceModel: null,
    platform: 'WEB',
    osVersion: null,
    appVersion: null,
    locationCountryCode: null,
    locationCity: null,
    user: { email: 'student@example.edu' },
    subjectSecurityEvents: [],
  };
  const prisma = {
    session: { findFirst: jest.fn() },
    securityEvent: { findFirst: jest.fn() },
    passwordResetToken: { findFirst: jest.fn() },
  };
  const mail = {
    sendNewSessionEmail: jest.fn(),
    sendSuspiciousActivityEmail: jest.fn(),
    sendPasswordChangedEmail: jest.fn(),
    sendPasswordResetRequestEmail: jest.fn(),
    sendPasswordResetCompletedEmail: jest.fn(),
  };
  let service: NotificationService;
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.session.findFirst.mockResolvedValue(session);
    service = new NotificationService(
      prisma as unknown as PrismaService,
      mail as unknown as MailService,
      {} as NotificationDeliveryService,
    );
  });
  it('uses an owned session and a stable domain key for enqueue', async () => {
    await service.sendNewSessionNotification('user-id', 'session-id');
    expect(prisma.session.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-id', userId: 'user-id' },
      }),
    );
    expect(mail.sendNewSessionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'NEW_SESSION:session-id',
        recipient: session.user.email,
        occurredAt: session.createdAt,
      }),
      { userId: 'user-id', sessionId: 'session-id' },
    );
  });
  it('does not enqueue an unknown or unowned session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);
    await service.sendNewSessionNotification('user-id', 'missing');
    expect(mail.sendNewSessionEmail).not.toHaveBeenCalled();
  });
  it('does not roll back successful authentication when enqueue fails or log raw causes', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    try {
      mail.sendNewSessionEmail.mockRejectedValueOnce(
        new Error('raw proof and connection string'),
      );
      await expect(
        service.sendNewSessionNotification('user-id', 'session-id'),
      ).resolves.toBeUndefined();
      expect(logger).toHaveBeenCalledWith({
        event: 'NOTIFICATION_MAIL_ENQUEUE_FAILED',
      });
      expect(JSON.stringify(logger.mock.calls)).not.toContain('raw proof');
    } finally {
      logger.mockRestore();
    }
  });
  it('carries the token owner/ID into the protected password-reset job', async () => {
    prisma.passwordResetToken.findFirst.mockResolvedValue({
      user: session.user,
    });
    await service.sendPasswordResetRequestNotification(
      'user-id',
      'token-id',
      'transient-token',
      1800,
    );
    expect(prisma.passwordResetToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'token-id', userId: 'user-id' } }),
    );
    expect(mail.sendPasswordResetRequestEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-id',
        tokenId: 'token-id',
        idempotencyKey: 'PASSWORD_RESET_REQUEST:token-id',
      }),
      { userId: 'user-id' },
    );
  });
});
