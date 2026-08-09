import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtTokenService } from './jwt-token.service';
import { SecureTokenService } from './secure-token.service';
import { SessionService } from './session.service';
import { GeoIpService } from '../../geo-ip/geo-ip.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import { RiskAnalysisService } from '../../security/services/risk-analysis.service';
import { NotificationService } from '../../notifications/services/notification.service';

jest.mock('crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

describe('SessionService', () => {
  const inactivityTtlSeconds = 31_536_000;
  const managementCooldownSeconds = 86_400;
  const activeSessionLimit = 10;
  const now = new Date('2026-08-08T12:00:00.000Z');
  const nextExpiresAt = new Date('2027-08-08T12:00:00.000Z');

  const prisma = {
    $transaction: jest.fn(),
    session: {
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const jwtTokenService = {
    generateTokens: jest.fn(),
  };
  const secureTokenService = {
    hash: jest.fn((token: string) => `hash:${token}`),
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SESSION_INACTIVITY_TTL_SECONDS') {
        return inactivityTtlSeconds;
      }

      if (key === 'SESSION_MANAGEMENT_COOLDOWN_SECONDS') {
        return managementCooldownSeconds;
      }

      if (key === 'SESSION_ACTIVE_LIMIT') {
        return activeSessionLimit;
      }

      throw new Error(`Unexpected configuration key: ${key}`);
    }),
  };
  const geoIpService = {
    lookup: jest.fn(),
  };
  const securityEventService = {
    record: jest.fn(),
  };
  const riskAnalysisService = {
    assessNewSession: jest.fn(),
    refreshTokenReuse: jest.fn(() => ({
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    })),
  };
  const notificationService = {
    sendSuspiciousActivityNotification: jest.fn(),
  };

  let service: SessionService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.session.count.mockResolvedValue(0);
    riskAnalysisService.assessNewSession.mockResolvedValue({
      level: null,
      signals: [],
    });
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );

    service = new SessionService(
      prisma as unknown as PrismaService,
      jwtTokenService as unknown as JwtTokenService,
      secureTokenService as unknown as SecureTokenService,
      geoIpService as unknown as GeoIpService,
      securityEventService as unknown as SecurityEventService,
      riskAnalysisService as unknown as RiskAnalysisService,
      notificationService as unknown as NotificationService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a session with the configured inactivity expiration', async () => {
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    prisma.session.create.mockResolvedValue({});
    geoIpService.lookup.mockReturnValue({
      countryCode: 'CA',
      city: 'Toronto',
    });

    await service.create('user-id', {
      ipAddress: '192.0.2.10',
      userAgent: 'Unicon/1.0 (iOS 18)',
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      osVersion: '18.6',
      appVersion: '1.4.2',
    });

    expect(jwtTokenService.generateTokens).toHaveBeenCalledWith(
      'user-id',
      expect.any(String),
      nextExpiresAt,
    );
    expect(prisma.session.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
    });
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        id: '00000000-0000-4000-8000-000000000000',
        userId: 'user-id',
        hashedRefreshToken: 'hash:refresh-token',
        expiresAt: nextExpiresAt,
        ipAddress: '192.0.2.10',
        userAgent: 'Unicon/1.0 (iOS 18)',
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        osVersion: '18.6',
        appVersion: '1.4.2',
        locationCountryCode: 'CA',
        locationCity: 'Toronto',
      },
    });
    expect(securityEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SESSION_CREATED',
        userId: 'user-id',
        actorSessionId: '00000000-0000-4000-8000-000000000000',
        subjectSessionId: '00000000-0000-4000-8000-000000000000',
      }),
      prisma,
    );
  });

  it('rejects session creation when the active session limit is reached', async () => {
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    geoIpService.lookup.mockReturnValue(null);
    prisma.session.count.mockResolvedValue(activeSessionLimit);

    await expect(
      service.create('user-id'),
    ).rejects.toMatchObject<ConflictException>({
      response: {
        code: 'SESSION_LIMIT_REACHED',
        message: 'The active session limit has been reached.',
        activeSessionLimit,
      },
    });

    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(securityEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SESSION_CREATION_FAILED',
        reason: 'ACTIVE_SESSION_LIMIT_REACHED',
        userId: 'user-id',
      }),
      prisma,
    );
  });

  it('retries session creation after a serializable transaction conflict', async () => {
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    geoIpService.lookup.mockReturnValue(null);
    prisma.session.create.mockResolvedValue({});
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

    await expect(service.create('user-id')).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionId: '00000000-0000-4000-8000-000000000000',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.session.create).toHaveBeenCalledTimes(1);
  });

  it('retries a driver-adapter transaction write conflict', async () => {
    const conflict = new Error('Transaction conflict.', {
      cause: { kind: 'TransactionWriteConflict' },
    });
    conflict.name = 'DriverAdapterError';
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    geoIpService.lookup.mockReturnValue(null);
    prisma.session.create.mockResolvedValue({});
    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(
        (callback: (transaction: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );

    await expect(service.create('user-id')).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('atomically rotates the refresh hash and extends session expiration', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:incoming-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: {
        status: 'ACTIVE',
      },
    });
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.refresh('user-id', 'session-id', 'incoming-token'),
    ).resolves.toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });

    expect(jwtTokenService.generateTokens).toHaveBeenCalledWith(
      'user-id',
      'session-id',
      nextExpiresAt,
    );
    expect(prisma.session.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        hashedRefreshToken: 'hash:incoming-token',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
        user: {
          status: 'ACTIVE',
        },
      },
      data: {
        hashedRefreshToken: 'hash:new-refresh-token',
        expiresAt: nextExpiresAt,
        lastActiveAt: now,
      },
    });
  });

  it('rejects a rotation that lost the atomic update race', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:incoming-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: {
        status: 'ACTIVE',
      },
    });
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.refresh('user-id', 'session-id', 'incoming-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not revoke the session for an already rotated token', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:current-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: {
        status: 'ACTIVE',
      },
    });

    await expect(
      service.refresh('user-id', 'session-id', 'old-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.session.updateMany).not.toHaveBeenCalled();
    expect(securityEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SUSPICIOUS_ACTIVITY_DETECTED',
        riskLevel: 'HIGH',
        riskSignals: ['REFRESH_TOKEN_REUSE'],
      }),
    );
    expect(
      notificationService.sendSuspiciousActivityNotification,
    ).toHaveBeenCalledWith('user-id', 'session-id', {
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    });
  });

  it('accepts an active session for access-token authorization', async () => {
    prisma.session.findFirst.mockResolvedValue({ id: 'session-id' });

    await expect(
      service.assertActive('user-id', 'session-id'),
    ).resolves.toBeUndefined();

    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
        user: {
          status: 'ACTIVE',
        },
      },
      select: {
        id: true,
      },
    });
  });

  it('rejects a revoked, expired, missing, or blocked session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(
      service.assertActive('user-id', 'session-id'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns active sessions ordered by activity and marks the current one', async () => {
    const session = {
      id: 'current-session-id',
      sessionName: 'Personal phone',
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      osVersion: '18.6',
      appVersion: '1.4.2',
      locationCountryCode: 'CA',
      locationCity: 'Toronto',
      userAgent: 'Unicon/1.0 (iOS 18)',
      ipAddress: '192.0.2.10',
      createdAt: now,
      lastActiveAt: now,
      expiresAt: nextExpiresAt,
    };
    prisma.session.findMany.mockResolvedValue([session]);

    await expect(
      service.findActiveByUser('user-id', 'current-session-id'),
    ).resolves.toEqual({
      sessionManagement: {
        canManageSessions: false,
        managementAvailableAt: new Date('2026-08-09T12:00:00.000Z'),
      },
      sessions: [
        {
          id: session.id,
          sessionName: session.sessionName,
          device: {
            model: session.deviceModel,
            platform: session.platform,
            osVersion: session.osVersion,
          },
          appVersion: session.appVersion,
          location: {
            countryCode: 'CA',
            city: 'Toronto',
          },
          userAgent: session.userAgent,
          ipAddress: session.ipAddress,
          createdAt: session.createdAt,
          lastActiveAt: session.lastActiveAt,
          expiresAt: session.expiresAt,
          current: true,
        },
      ],
    });

    expect(prisma.session.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-id',
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      select: {
        id: true,
        sessionName: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastActiveAt: true,
        expiresAt: true,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
    });
  });

  it('creates a session when GeoIP cannot determine a location', async () => {
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    prisma.session.create.mockResolvedValue({});
    geoIpService.lookup.mockReturnValue(null);

    await expect(
      service.create('user-id', { platform: 'UNKNOWN' }),
    ).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionId: '00000000-0000-4000-8000-000000000000',
    });

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        id: '00000000-0000-4000-8000-000000000000',
        userId: 'user-id',
        hashedRefreshToken: 'hash:refresh-token',
        expiresAt: nextExpiresAt,
        ipAddress: undefined,
        userAgent: undefined,
        deviceModel: undefined,
        platform: 'UNKNOWN',
        osVersion: undefined,
        appVersion: undefined,
        locationCountryCode: undefined,
        locationCity: undefined,
      },
    });
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
