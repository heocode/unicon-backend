import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../../prisma/prisma.service';
import { SessionQueryService } from './session-query.service';

describe('SessionQueryService', () => {
  const managementCooldownSeconds = 86_400;
  const now = new Date('2026-08-08T12:00:00.000Z');
  const nextExpiresAt = new Date('2027-08-08T12:00:00.000Z');
  const prisma = {
    session: {
      findMany: jest.fn(),
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

  let service: SessionQueryService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();

    service = new SessionQueryService(
      prisma as unknown as PrismaService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns active sessions ordered by activity and marks the current one', async () => {
    const session = {
      id: 'current-session-id',
      sessionName: 'Personal phone',
      deviceModelIdentifier: 'iPhone17,1',
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
            modelIdentifier: session.deviceModelIdentifier,
            model: session.deviceModel,
            platform: session.platform,
            osVersion: session.osVersion,
          },
          appVersion: session.appVersion,
          location: { countryCode: 'CA', city: 'Toronto' },
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
        expiresAt: { gt: now },
      },
      select: {
        id: true,
        sessionName: true,
        deviceModelIdentifier: true,
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
      orderBy: { lastActiveAt: 'desc' },
    });
  });

  it('rejects the list when the current session is unavailable', async () => {
    prisma.session.findMany.mockResolvedValue([]);

    await expect(
      service.findActiveByUser('user-id', 'current-session-id'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns null identifiers for sessions created by legacy clients', async () => {
    prisma.session.findMany.mockResolvedValue([
      {
        id: 'current-session-id',
        sessionName: null,
        deviceModelIdentifier: null,
        deviceModel: 'Legacy device',
        platform: 'IOS',
        osVersion: null,
        appVersion: null,
        locationCountryCode: null,
        locationCity: null,
        userAgent: null,
        ipAddress: null,
        createdAt: new Date('2026-08-07T12:00:00.000Z'),
        lastActiveAt: now,
        expiresAt: nextExpiresAt,
      },
    ]);

    const result = await service.findActiveByUser(
      'user-id',
      'current-session-id',
    );

    expect(result.sessions[0].device).toEqual({
      modelIdentifier: null,
      model: 'Legacy device',
      platform: 'IOS',
      osVersion: null,
    });
  });
});
