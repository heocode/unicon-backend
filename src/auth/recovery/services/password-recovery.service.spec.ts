import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationService } from '../../../notifications/services/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { PasswordService } from '../../password/services/password.service';
import { SecureTokenService } from '../../services/secure-token.service';
import { PasswordRecoveryService } from './password-recovery.service';
import { RecoveryRateLimitService } from './recovery-rate-limit.service';

describe('PasswordRecoveryService', () => {
  const metadata = { ipAddress: '192.0.2.1', platform: 'WEB' as const };
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    user: { findFirst: jest.fn(), updateMany: jest.fn() },
    passwordResetToken: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    session: { updateMany: jest.fn() },
  };
  const passwordService = { hash: jest.fn() };
  const tokenService = { generateWithSeconds: jest.fn(), hash: jest.fn() };
  const securityEventService = {
    snapshotFromMetadata: jest.fn(),
    record: jest.fn(),
  };
  const notificationService = {
    sendPasswordResetRequestNotification: jest.fn(),
    sendPasswordResetCompletedNotification: jest.fn(),
  };
  const rateLimitService = { consumeIp: jest.fn(), consumeEmail: jest.fn() };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue(1800),
  };
  let service: PasswordRecoveryService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (client: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'ACTIVE',
        passwordHash: 'old-password-hash',
        deletionScheduledAt: null,
      },
    ]);
    rateLimitService.consumeIp.mockResolvedValue({ allowed: true });
    rateLimitService.consumeEmail.mockResolvedValue({ allowed: true });
    securityEventService.snapshotFromMetadata.mockReturnValue({
      ipAddress: metadata.ipAddress,
      platform: 'WEB',
    });
    service = new PasswordRecoveryService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      tokenService as unknown as SecureTokenService,
      securityEventService as unknown as SecurityEventService,
      notificationService as unknown as NotificationService,
      rateLimitService as unknown as RecoveryRateLimitService,
      configService as unknown as ConfigService,
    );
  });

  it('returns the generic response without revealing an unknown email', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(
      service.requestReset({ email: 'unknown@example.edu' }, metadata),
    ).resolves.toEqual({
      message:
        'If an eligible account exists, password reset instructions will be sent.',
    });
    expect(tokenService.generateWithSeconds).not.toHaveBeenCalled();
  });

  it('does not issue recovery credentials for a deletion-scheduled account', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.requestReset({ email: 'scheduled@example.edu' }, metadata),
    ).resolves.toEqual({
      message:
        'If an eligible account exists, password reset instructions will be sent.',
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        email: 'scheduled@example.edu',
        status: 'ACTIVE',
        emailVerified: true,
      },
      select: { id: true },
    });
    expect(tokenService.generateWithSeconds).not.toHaveBeenCalled();
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(securityEventService.record).not.toHaveBeenCalled();
    expect(
      notificationService.sendPasswordResetRequestNotification,
    ).not.toHaveBeenCalled();
  });

  it('returns 429 when the IP request limit is exhausted', async () => {
    rateLimitService.consumeIp.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 120,
    });
    await expect(
      service.requestReset({ email: 'student@example.edu' }, metadata),
    ).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 120,
      },
    });
    expect(rateLimitService.consumeEmail).not.toHaveBeenCalled();
  });

  it('returns 429 when the email request limit is exhausted', async () => {
    rateLimitService.consumeEmail.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 90,
    });

    await expect(
      service.requestReset({ email: 'student@example.edu' }, metadata),
    ).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 90,
      },
    });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('rejects mismatched reset passwords before querying a token', async () => {
    await expect(
      service.reset(
        {
          token: 'a'.repeat(64),
          newPassword: 'NewPassword2!',
          confirmNewPassword: 'OtherPassword3!',
        },
        metadata,
      ),
    ).rejects.toMatchObject<BadRequestException>({
      response: { code: 'PASSWORDS_DO_NOT_MATCH' },
    });
    expect(prisma.passwordResetToken.findFirst).not.toHaveBeenCalled();
  });

  it('atomically consumes a token, changes the password, and revokes all sessions', async () => {
    tokenService.hash.mockReturnValue('token-hash');
    passwordService.hash.mockResolvedValue('next-password-hash');
    prisma.passwordResetToken.findFirst.mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      user: { passwordHash: 'old-password-hash' },
    });
    prisma.passwordResetToken.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.session.updateMany.mockResolvedValue({ count: 3 });
    securityEventService.record.mockResolvedValue({ id: 'event-id' });

    await expect(
      service.reset(
        {
          token: 'a'.repeat(64),
          newPassword: 'NewPassword2!',
          confirmNewPassword: 'NewPassword2!',
        },
        metadata,
      ),
    ).resolves.toEqual({
      message: 'Password reset successfully.',
      revokedSessionsCount: 3,
    });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
        status: 'ACTIVE',
        emailVerified: true,
        passwordHash: 'old-password-hash',
      },
      data: { passwordHash: 'next-password-hash' },
    });
    expect(prisma.session.updateMany).toHaveBeenCalledTimes(1);
    expect(
      notificationService.sendPasswordResetCompletedNotification,
    ).toHaveBeenCalledWith('user-id', 'event-id');
  });

  it('rejects reset when deletion wins the user lifecycle lock', async () => {
    tokenService.hash.mockReturnValue('token-hash');
    prisma.passwordResetToken.findFirst.mockResolvedValue({
      id: 'token-id',
      userId: 'user-id',
      user: { passwordHash: 'old-password-hash' },
    });
    passwordService.hash.mockResolvedValue('next-password-hash');
    prisma.$queryRaw.mockResolvedValue([
      {
        status: 'DELETION_SCHEDULED',
        passwordHash: 'old-password-hash',
        deletionScheduledAt: new Date(),
      },
    ]);

    await expect(
      service.reset(
        {
          token: 'a'.repeat(64),
          newPassword: 'NewPassword2!',
          confirmNewPassword: 'NewPassword2!',
        },
        metadata,
      ),
    ).rejects.toMatchObject<BadRequestException>({
      response: { code: 'PASSWORD_RESET_TOKEN_INVALID' },
    });

    expect(prisma.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});
