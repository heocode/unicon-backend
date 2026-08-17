import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';

import { PasswordService } from '../../auth/password/services/password.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import { PasswordChangeService } from './password-change.service';

describe('PasswordChangeService', () => {
  const now = new Date('2026-08-16T12:00:00.000Z');
  const dto = {
    currentPassword: 'CurrentPassword1!',
    newPassword: 'NewPassword2!',
    confirmNewPassword: 'NewPassword2!',
  };
  const currentSession = {
    ipAddress: '192.0.2.10',
    userAgent: 'Unicon/1.0',
    deviceModel: 'iPhone 16 Pro',
    platform: 'IOS',
    osVersion: '18.6',
    appVersion: '1.4.2',
    locationCountryCode: 'CA',
    locationCity: 'Toronto',
  };
  const prisma = {
    $transaction: jest.fn(),
    user: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    session: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const passwordService = {
    compare: jest.fn(),
    hash: jest.fn(),
  };
  const securityEventService = {
    record: jest.fn(),
  };
  const notificationService = {
    sendPasswordChangedNotification: jest.fn(),
  };

  let service: PasswordChangeService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();

    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    prisma.user.findFirst.mockResolvedValue({ passwordHash: 'current-hash' });
    prisma.session.findFirst.mockResolvedValue(currentSession);
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.updateMany.mockResolvedValue({ count: 2 });
    passwordService.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    passwordService.hash.mockResolvedValue('next-hash');
    securityEventService.record.mockResolvedValue({ id: 'event-id' });
    notificationService.sendPasswordChangedNotification.mockResolvedValue(
      undefined,
    );

    service = new PasswordChangeService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      securityEventService as unknown as SecurityEventService,
      notificationService as unknown as NotificationService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects mismatched new passwords before querying the database', async () => {
    await expect(
      service.change('user-id', 'session-id', {
        ...dto,
        confirmNewPassword: 'DifferentPassword3!',
      }),
    ).rejects.toMatchObject<BadRequestException>({
      response: {
        code: 'PASSWORDS_DO_NOT_MATCH',
        message: 'The new passwords do not match.',
      },
    });

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(passwordService.compare).not.toHaveBeenCalled();
  });

  it('rejects an unavailable account', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.change('user-id', 'session-id', dto),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: {
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'The account is unavailable.',
      },
    });

    expect(passwordService.compare).not.toHaveBeenCalled();
  });

  it('rejects an invalid current password', async () => {
    passwordService.compare.mockReset().mockResolvedValue(false);

    await expect(
      service.change('user-id', 'session-id', dto),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: {
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'The current password is invalid.',
      },
    });

    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reusing the current password', async () => {
    passwordService.compare.mockReset().mockResolvedValue(true);

    await expect(
      service.change('user-id', 'session-id', dto),
    ).rejects.toMatchObject<BadRequestException>({
      response: {
        code: 'NEW_PASSWORD_SAME_AS_CURRENT',
        message: 'The new password must differ from the current password.',
      },
    });

    expect(passwordService.hash).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when the current session becomes unavailable', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(
      service.change('user-id', 'session-id', dto),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: {
        code: 'SESSION_UNAVAILABLE',
        message: 'The current session is unavailable.',
      },
    });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(securityEventService.record).not.toHaveBeenCalled();
  });

  it('rejects a password update that loses the conditional race', async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.change('user-id', 'session-id', dto),
    ).rejects.toMatchObject<ConflictException>({
      response: {
        code: 'PASSWORD_CHANGED_CONCURRENTLY',
        message: 'The password was changed by another request.',
      },
    });

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(securityEventService.record).not.toHaveBeenCalled();
  });

  it('changes the password, preserves the current session, and records the event atomically', async () => {
    await expect(service.change('user-id', 'session-id', dto)).resolves.toEqual(
      {
        message: 'Password changed successfully.',
        revokedSessionsCount: 2,
      },
    );

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'user-id', status: 'ACTIVE' },
      select: { passwordHash: true },
    });
    expect(passwordService.compare).toHaveBeenNthCalledWith(
      1,
      dto.currentPassword,
      'current-hash',
    );
    expect(passwordService.compare).toHaveBeenNthCalledWith(
      2,
      dto.newPassword,
      'current-hash',
    );
    expect(passwordService.hash).toHaveBeenCalledWith(dto.newPassword);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
        passwordHash: 'current-hash',
        status: 'ACTIVE',
      },
      data: { passwordHash: 'next-hash' },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        id: { not: 'session-id' },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });
    expect(securityEventService.record).toHaveBeenCalledWith(
      {
        type: 'PASSWORD_CHANGED',
        userId: 'user-id',
        actorSessionId: 'session-id',
        affectedSessionCount: 2,
        occurredAt: now,
        ...currentSession,
      },
      prisma,
    );
    expect(
      notificationService.sendPasswordChangedNotification,
    ).toHaveBeenCalledWith('user-id', 'event-id');
  });

  it('keeps a committed password change successful when notification dispatch fails', async () => {
    notificationService.sendPasswordChangedNotification.mockRejectedValue(
      new Error('Notification unavailable.'),
    );

    await expect(service.change('user-id', 'session-id', dto)).resolves.toEqual(
      {
        message: 'Password changed successfully.',
        revokedSessionsCount: 2,
      },
    );
  });
});
