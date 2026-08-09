import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtTokenService } from './jwt-token.service';
import { SecureTokenService } from './secure-token.service';
import { SessionService } from './session.service';
import { GeoIpService } from '../../geo-ip/geo-ip.service';

jest.mock('crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

describe('SessionService', () => {
  const inactivityTtlSeconds = 31_536_000;
  const now = new Date('2026-08-08T12:00:00.000Z');
  const nextExpiresAt = new Date('2027-08-08T12:00:00.000Z');

  const prisma = {
    session: {
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
    getOrThrow: jest.fn().mockReturnValue(inactivityTtlSeconds),
  };
  const geoIpService = {
    lookup: jest.fn(),
  };

  let service: SessionService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();

    service = new SessionService(
      prisma as unknown as PrismaService,
      jwtTokenService as unknown as JwtTokenService,
      secureTokenService as unknown as SecureTokenService,
      geoIpService as unknown as GeoIpService,
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
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
      lastActiveAt: now,
      expiresAt: nextExpiresAt,
    };
    prisma.session.findMany.mockResolvedValue([session]);

    await expect(
      service.findActiveByUser('user-id', 'current-session-id'),
    ).resolves.toEqual({
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
    prisma.session.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.rename('user-id', 'session-id', 'Personal phone'),
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
});
