import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { SessionManagementService } from './session-management.service';

describe('SessionManagementService', () => {
  const managementCooldownSeconds = 86_400;
  const now = new Date('2026-08-08T12:00:00.000Z');

  const prisma = {
    $transaction: jest.fn(),
    session: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SESSION_MANAGEMENT_COOLDOWN_SECONDS') {
        return managementCooldownSeconds;
      }

      throw new Error(`Unexpected configuration key: ${key}`);
    }),
  };
  const securityEventService = {
    record: jest.fn(),
  };

  let service: SessionManagementService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );

    service = new SessionManagementService(
      prisma as unknown as PrismaService,
      securityEventService as unknown as SecurityEventService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renames an active session belonging to the user', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.rename('user-id', 'session-id', 'session-id', 'Personal phone'),
    ).resolves.toEqual({
      id: 'session-id',
      sessionName: 'Personal phone',
    });

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        sessionName: 'Personal phone',
      },
    });
  });

  it('clears the current session name', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.rename('user-id', 'session-id', 'session-id', null),
    ).resolves.toEqual({
      id: 'session-id',
      sessionName: null,
    });

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        sessionName: null,
      },
    });
  });

  it('prevents a fresh session from renaming itself', async () => {
    prisma.session.findFirst.mockResolvedValue({ createdAt: now });

    await expect(
      service.rename('user-id', 'session-id', 'session-id', 'Personal phone'),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'SESSION_TOO_FRESH',
        message: 'This session is too new to manage sessions.',
        managementAvailableAt: new Date('2026-08-09T12:00:00.000Z'),
        retryAfterSeconds: 86_400,
      },
    });

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('prevents a fresh session from renaming another session', async () => {
    prisma.session.findFirst.mockResolvedValue({ createdAt: now });

    await expect(
      service.rename(
        'user-id',
        'current-session-id',
        'target-id',
        'Renamed device',
      ),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'SESSION_TOO_FRESH',
        message: 'This session is too new to manage sessions.',
        managementAvailableAt: new Date('2026-08-09T12:00:00.000Z'),
        retryAfterSeconds: 86_400,
      },
    });

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('allows a mature session to rename another session', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.rename(
        'user-id',
        'current-session-id',
        'target-id',
        'Renamed device',
      ),
    ).resolves.toEqual({
      id: 'target-id',
      sessionName: 'Renamed device',
    });
  });

  it('allows a fresh session to revoke itself', async () => {
    prisma.session.findFirst.mockResolvedValue({ createdAt: now });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.revokeSelected('user-id', 'session-id', 'session-id'),
    ).resolves.toBeUndefined();

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        revokedAt: now,
      },
    });
  });

  it('prevents a fresh session from revoking another session', async () => {
    prisma.session.findFirst.mockResolvedValue({ createdAt: now });

    await expect(
      service.revokeSelected('user-id', 'current-session-id', 'target-id'),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'SESSION_TOO_FRESH',
        message: 'This session is too new to manage sessions.',
        managementAvailableAt: new Date('2026-08-09T12:00:00.000Z'),
        retryAfterSeconds: 86_400,
      },
    });

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('allows a mature session to revoke an older or newer session', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.revokeSelected('user-id', 'current-session-id', 'target-id'),
    ).resolves.toBeUndefined();

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'target-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        revokedAt: now,
      },
    });
  });

  it('allows revocation exactly when the cooldown expires', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.revokeSelected('user-id', 'current-session-id', 'target-id'),
    ).resolves.toBeUndefined();
  });

  it('returns a stable not-found error for an unavailable target session', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T11:59:59.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.revokeSelected('user-id', 'current-session-id', 'target-id'),
    ).rejects.toMatchObject<NotFoundException>({
      response: {
        code: 'SESSION_NOT_FOUND',
        message: 'Active session not found.',
      },
    });
  });

  it('atomically revokes all other active sessions for a mature session', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 3 });

    await expect(
      service.revokeOthers('user-id', 'current-session-id'),
    ).resolves.toEqual({
      revokedSessionsCount: 3,
    });

    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        id: {
          not: 'current-session-id',
        },
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        revokedAt: now,
      },
    });
  });

  it('prevents a fresh session from revoking all other sessions', async () => {
    prisma.session.findFirst.mockResolvedValue({ createdAt: now });

    await expect(
      service.revokeOthers('user-id', 'current-session-id'),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'SESSION_TOO_FRESH',
        message: 'This session is too new to manage sessions.',
        managementAvailableAt: new Date('2026-08-09T12:00:00.000Z'),
        retryAfterSeconds: 86_400,
      },
    });

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });

  it('succeeds when there are no other active sessions to revoke', async () => {
    prisma.session.findFirst.mockResolvedValue({
      createdAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.revokeOthers('user-id', 'current-session-id'),
    ).resolves.toEqual({
      revokedSessionsCount: 0,
    });
  });

  it('rejects revoke-others when the current session is unavailable', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(
      service.revokeOthers('user-id', 'current-session-id'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
  });
});
