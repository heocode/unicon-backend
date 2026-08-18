import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { NotificationService } from '../notifications/services/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventService } from '../security/services/security-event.service';
import { PasswordService } from './password/services/password.service';
import { PasswordRecoveryService } from './recovery/services/password-recovery.service';
import { EmailVerificationService } from './services/email-verification.service';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';
import { SessionCreationService } from './session/services/session-creation.service';
import { SessionManagementService } from './session/services/session-management.service';
import { SessionQueryService } from './session/services/session-query.service';
import { SessionRefreshService } from './session/services/session-refresh.service';
import { AuthService } from './auth.service';

describe('AuthService deletion-aware login', () => {
  const metadata = { platform: 'WEB' as const };
  const prisma = { user: { findUnique: jest.fn() } };
  const passwordService = { compare: jest.fn() };
  const securityEventService = {
    record: jest.fn(),
    snapshotFromMetadata: jest.fn(),
  };
  const sessionCreationService = { create: jest.fn() };
  const notificationService = { sendNewSessionNotification: jest.fn() };

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    passwordService.compare.mockResolvedValue(true);
    securityEventService.record.mockResolvedValue({ id: 'event-id' });
    securityEventService.snapshotFromMetadata.mockReturnValue({
      platform: 'WEB',
    });

    service = new AuthService(
      prisma as unknown as PrismaService,
      passwordService as unknown as PasswordService,
      {} as SecureTokenService,
      {} as UsernameService,
      sessionCreationService as unknown as SessionCreationService,
      {} as SessionRefreshService,
      {} as SessionQueryService,
      {} as SessionManagementService,
      {} as EmailVerificationService,
      securityEventService as unknown as SecurityEventService,
      notificationService as unknown as NotificationService,
      {} as PasswordRecoveryService,
    );
  });

  it('returns the stored deadline when deletion can still be cancelled', async () => {
    const deadline = new Date(Date.now() + 60_000);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      email: 'student@example.edu',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      verificationEmailSentAt: null,
      deletionScheduledAt: deadline,
    });

    await expect(
      service.login(
        { email: 'student@example.edu', password: 'Password1!' },
        metadata,
      ),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'ACCOUNT_DELETION_SCHEDULED',
        details: { deletionScheduledAt: deadline, canCancel: true },
      },
    });

    expect(securityEventService.record).not.toHaveBeenCalled();
    expect(sessionCreationService.create).not.toHaveBeenCalled();
    expect(
      notificationService.sendNewSessionNotification,
    ).not.toHaveBeenCalled();
  });

  it('reports an expired grace period without creating a session', async () => {
    const deadline = new Date(Date.now() - 1);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      email: 'student@example.edu',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      verificationEmailSentAt: null,
      deletionScheduledAt: deadline,
    });

    await expect(
      service.login(
        { email: 'student@example.edu', password: 'Password1!' },
        metadata,
      ),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
        details: { deletionScheduledAt: deadline, canCancel: false },
      },
    });

    expect(sessionCreationService.create).not.toHaveBeenCalled();
  });

  it('does not reveal deletion state when the password is invalid', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-id',
      email: 'student@example.edu',
      passwordHash: 'password-hash',
      status: 'DELETION_SCHEDULED',
      verificationEmailSentAt: null,
      deletionScheduledAt: new Date(Date.now() + 60_000),
    });
    passwordService.compare.mockResolvedValue(false);

    await expect(
      service.login(
        { email: 'student@example.edu', password: 'WrongPassword1!' },
        metadata,
      ),
    ).rejects.toMatchObject<UnauthorizedException>({
      message: 'Invalid email or password.',
    });

    expect(sessionCreationService.create).not.toHaveBeenCalled();
  });
});
