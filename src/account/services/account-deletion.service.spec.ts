import {
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PasswordService } from '../../auth/password/services/password.service';
import { SessionCreationService } from '../../auth/session/services/session-creation.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import { AccountDeletionNotificationService } from '../../notifications/services/account-deletion-notification.service';
import { AccountDeletionService } from './account-deletion.service';
import { AccountDeletionCancellationRateLimitService } from './account-deletion-cancellation-rate-limit.service';

describe('AccountDeletionService', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const gracePeriodSeconds = 2_592_000;
  const deletionScheduledAt = new Date('2026-09-16T12:00:00.000Z');
  const dto = { currentPassword: 'CurrentPassword1!' };
  const currentSession = {
    ipAddress: '192.0.2.10',
    userAgent: 'Unicon/1.0',
    deviceModelIdentifier: 'iPhone17,1',
    deviceModel: 'iPhone 16 Pro',
    platform: 'IOS',
    osVersion: '18.6',
    appVersion: '1.4.2',
    locationCountryCode: 'CA',
    locationCity: 'Toronto',
  };
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    session: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    passwordResetToken: {
      updateMany: jest.fn(),
    },
  };
  const passwordService = { compare: jest.fn() };
  const preparedSession = {
    result: {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      sessionId: 'new-session-id',
    },
    data: {
      id: 'new-session-id',
      userId: 'user-id',
      hashedRefreshToken: 'new-refresh-hash',
      expiresAt: new Date('2027-08-17T12:00:00.000Z'),
    },
    occurredAt: now,
  };
  const sessionCreationService = {
    prepare: jest.fn(),
    createInTransaction: jest.fn(),
    assertCreated: jest.fn(),
  };
  const securityEventService = {
    record: jest.fn(),
    snapshotFromMetadata: jest.fn(),
  };
  const cancellationRateLimitService = {
    consumeIp: jest.fn(),
    consumeEmail: jest.fn(),
  };
  const notificationService = {
    sendDeletionRequested: jest.fn(),
    sendDeletionCancelled: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn(() => gracePeriodSeconds),
  };

  let service: AccountDeletionService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();

    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    prisma.user.findFirst.mockResolvedValue({ passwordHash: 'password-hash' });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt,
    });
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'ACTIVE',
        passwordHash: 'password-hash',
        deletionScheduledAt: null,
      },
    ]);
    prisma.session.findFirst.mockResolvedValue(currentSession);
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.updateMany.mockResolvedValue({ count: 3 });
    prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 2 });
    passwordService.compare.mockResolvedValue(true);
    sessionCreationService.prepare.mockResolvedValue(preparedSession);
    sessionCreationService.createInTransaction.mockResolvedValue({
      created: true,
    });
    securityEventService.snapshotFromMetadata.mockReturnValue({
      ipAddress: '192.0.2.20',
      platform: 'WEB',
    });
    securityEventService.record.mockResolvedValue({ id: 'event-id' });
    cancellationRateLimitService.consumeIp.mockResolvedValue({ allowed: true });
    cancellationRateLimitService.consumeEmail.mockResolvedValue({
      allowed: true,
    });
    notificationService.sendDeletionRequested.mockResolvedValue(undefined);
    notificationService.sendDeletionCancelled.mockResolvedValue(undefined);

    service = new AccountDeletionService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      sessionCreationService as unknown as SessionCreationService,
      securityEventService as unknown as SecurityEventService,
      cancellationRateLimitService as unknown as AccountDeletionCancellationRateLimitService,
      notificationService as unknown as AccountDeletionNotificationService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules deletion and atomically revokes credentials', async () => {
    await expect(
      service.request('user-id', 'session-id', dto),
    ).resolves.toEqual({
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt,
      gracePeriodSeconds,
    });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
        status: 'ACTIVE',
        passwordHash: 'password-hash',
      },
      data: {
        status: 'DELETION_SCHEDULED',
        deletionRequestedAt: now,
        deletionScheduledAt,
        hashedVerificationToken: null,
        verificationTokenExpires: null,
        verificationEmailSentAt: null,
      },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-id', revokedAt: null },
      data: { revokedAt: now },
    });
    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        usedAt: null,
        invalidatedAt: null,
      },
      data: { invalidatedAt: now },
    });
    expect(securityEventService.record).toHaveBeenCalledWith(
      {
        type: 'ACCOUNT_DELETION_REQUESTED',
        userId: 'user-id',
        actorSessionId: 'session-id',
        affectedSessionCount: 3,
        occurredAt: now,
        ...currentSession,
      },
      prisma,
    );
    expect(notificationService.sendDeletionRequested).toHaveBeenCalledWith(
      'user-id',
      'event-id',
      deletionScheduledAt,
    );
  });

  it('rejects an unavailable account before password verification', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.request('user-id', 'session-id', dto),
    ).rejects.toMatchObject<ForbiddenException>({
      response: { code: 'ACCOUNT_UNAVAILABLE' },
    });

    expect(passwordService.compare).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an invalid current password without starting a transaction', async () => {
    passwordService.compare.mockResolvedValue(false);

    await expect(
      service.request('user-id', 'session-id', dto),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: { code: 'CURRENT_PASSWORD_INVALID' },
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects when the authenticated session becomes unavailable', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(
      service.request('user-id', 'session-id', dto),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: { code: 'SESSION_UNAVAILABLE' },
    });

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a concurrent account or password state change', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'ACTIVE',
        passwordHash: 'changed-password-hash',
        deletionScheduledAt: null,
      },
    ]);

    await expect(
      service.request('user-id', 'session-id', dto),
    ).rejects.toMatchObject<ConflictException>({
      response: { code: 'ACCOUNT_STATE_CHANGED' },
    });

    expect(prisma.session.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('returns the original deadline for a concurrent repeated request', async () => {
    const existingDeadline = new Date('2026-09-15T10:00:00.000Z');
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'DELETION_SCHEDULED',
        passwordHash: 'password-hash',
        deletionScheduledAt: existingDeadline,
      },
    ]);

    await expect(
      service.request('user-id', 'session-id', dto),
    ).resolves.toEqual({
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt: existingDeadline,
      gracePeriodSeconds,
    });

    expect(prisma.session.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(securityEventService.record).not.toHaveBeenCalled();
    expect(notificationService.sendDeletionRequested).not.toHaveBeenCalled();
  });

  it('cancels deletion and creates exactly one new session atomically', async () => {
    const metadata = { ipAddress: '192.0.2.20', platform: 'WEB' as const };
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'DELETION_SCHEDULED',
        passwordHash: 'password-hash',
        deletionScheduledAt,
      },
    ]);

    await expect(
      service.cancel(
        {
          email: 'student@my.centennialcollege.ca',
          currentPassword: 'CurrentPassword1!',
        },
        metadata,
      ),
    ).resolves.toEqual({
      status: 'ACTIVE',
      deletionCancelled: true,
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
        status: 'DELETION_SCHEDULED',
        passwordHash: 'password-hash',
        deletionScheduledAt,
      },
      data: {
        status: 'ACTIVE',
        deletionRequestedAt: null,
        deletionScheduledAt: null,
      },
    });
    expect(sessionCreationService.prepare).toHaveBeenCalledWith(
      'user-id',
      metadata,
    );
    expect(sessionCreationService.createInTransaction).toHaveBeenCalledWith(
      prisma,
      preparedSession,
    );
    expect(sessionCreationService.assertCreated).toHaveBeenCalledWith({
      created: true,
    });
    expect(securityEventService.record).toHaveBeenCalledWith(
      {
        type: 'ACCOUNT_DELETION_CANCELLED',
        userId: 'user-id',
        occurredAt: now,
        ipAddress: '192.0.2.20',
        platform: 'WEB',
      },
      prisma,
    );
    expect(notificationService.sendDeletionCancelled).toHaveBeenCalledWith(
      'user-id',
      'event-id',
    );
  });

  it('does not fail a committed cancellation when notification dispatch rejects', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'DELETION_SCHEDULED',
        passwordHash: 'password-hash',
        deletionScheduledAt,
      },
    ]);
    notificationService.sendDeletionCancelled.mockRejectedValue(
      new Error('Notification unavailable.'),
    );

    await expect(
      service.cancel(
        {
          email: 'student@example.edu',
          currentPassword: 'CurrentPassword1!',
        },
        { platform: 'WEB' },
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE', deletionCancelled: true });
  });

  it('returns the same invalid-credentials error for an unknown email or wrong password', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.cancel(
        { email: 'unknown@example.edu', currentPassword: 'Password1!' },
        { platform: 'UNKNOWN' },
      ),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: { code: 'INVALID_CREDENTIALS' },
    });

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt,
    });
    passwordService.compare.mockResolvedValue(false);

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'WrongPassword1!' },
        { platform: 'UNKNOWN' },
      ),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: { code: 'INVALID_CREDENTIALS' },
    });

    expect(sessionCreationService.prepare).not.toHaveBeenCalled();
  });

  it('rejects an IP-limited cancellation before consuming the email bucket', async () => {
    cancellationRateLimitService.consumeIp.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 120,
    });

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { ipAddress: '192.0.2.20', platform: 'WEB' },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        details: { retryAfterSeconds: 120 },
      },
    });

    expect(cancellationRateLimitService.consumeEmail).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an email-limited cancellation before account lookup', async () => {
    cancellationRateLimitService.consumeEmail.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 60,
    });

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { ipAddress: '192.0.2.20', platform: 'WEB' },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        details: { retryAfterSeconds: 60 },
      },
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(passwordService.compare).not.toHaveBeenCalled();
  });

  it('rejects an expired grace period before preparing a session', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt: now,
    });

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { platform: 'UNKNOWN' },
      ),
    ).rejects.toMatchObject<ConflictException>({
      response: { code: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED' },
    });

    expect(sessionCreationService.prepare).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create another session when deletion was already cancelled', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      passwordHash: 'password-hash',
      status: 'ACTIVE',
      deletionScheduledAt: null,
    });

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { platform: 'UNKNOWN' },
      ),
    ).rejects.toMatchObject<ConflictException>({
      response: { code: 'ACCOUNT_DELETION_ALREADY_CANCELLED' },
    });

    expect(sessionCreationService.prepare).not.toHaveBeenCalled();
  });

  it('rejects non-cancellable account states with invalid credentials', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      passwordHash: 'password-hash',
      status: 'BLOCKED',
      deletionScheduledAt: null,
    });

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { platform: 'UNKNOWN' },
      ),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it('retries the entire cancellation transaction after a serialization conflict', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'DELETION_SCHEDULED',
        passwordHash: 'password-hash',
        deletionScheduledAt,
      },
    ]);
    prisma.$transaction
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Transaction conflict.', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      )
      .mockImplementationOnce(
        (callback: (transaction: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );

    await expect(
      service.cancel(
        { email: 'student@example.edu', currentPassword: 'Password1!' },
        { platform: 'UNKNOWN' },
      ),
    ).resolves.toMatchObject({ status: 'ACTIVE' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(sessionCreationService.prepare).toHaveBeenCalledTimes(1);
  });
});
