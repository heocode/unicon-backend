import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationService } from '../../../notifications/services/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';
import { SessionRefreshService } from './session-refresh.service';

describe('SessionRefreshService', () => {
  const inactivityTtlSeconds = 31_536_000;
  const now = new Date('2026-08-08T12:00:00.000Z');
  const nextExpiresAt = new Date('2027-08-08T12:00:00.000Z');
  const prisma = {
    session: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const jwtTokenService = { generateTokens: jest.fn() };
  const secureTokenService = {
    hash: jest.fn((token: string) => `hash:${token}`),
  };
  const securityEventService = { record: jest.fn() };
  const riskAnalysisService = {
    refreshTokenReuse: jest.fn(() => ({
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    })),
  };
  const notificationService = {
    sendSuspiciousActivityNotification: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SESSION_INACTIVITY_TTL_SECONDS') {
        return inactivityTtlSeconds;
      }

      throw new Error(`Unexpected configuration key: ${key}`);
    }),
  };

  let service: SessionRefreshService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();

    service = new SessionRefreshService(
      prisma as unknown as PrismaService,
      jwtTokenService as unknown as JwtTokenService,
      secureTokenService as unknown as SecureTokenService,
      securityEventService as unknown as SecurityEventService,
      riskAnalysisService as unknown as RiskAnalysisService,
      notificationService as unknown as NotificationService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('atomically rotates the refresh hash and extends session expiration', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:incoming-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: { status: 'ACTIVE' },
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
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
      },
      data: {
        hashedRefreshToken: 'hash:new-refresh-token',
        expiresAt: nextExpiresAt,
        lastActiveAt: now,
      },
    });
  });

  it('rejects a rotation that lost the atomic update race', async () => {
    prisma.session.findFirst
      .mockResolvedValueOnce({
        id: 'session-id',
        hashedRefreshToken: 'hash:incoming-token',
        expiresAt: new Date('2026-08-09T12:00:00.000Z'),
        user: { status: 'ACTIVE' },
      })
      .mockResolvedValueOnce(null);
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.refresh('user-id', 'session-id', 'incoming-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(securityEventService.record).not.toHaveBeenCalled();
  });

  it('records and notifies when the supplied refresh token was already rotated', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:current-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: { status: 'ACTIVE' },
      ipAddress: '192.0.2.10',
      platform: 'IOS',
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
        ipAddress: '192.0.2.10',
        platform: 'IOS',
      }),
    );
    expect(
      notificationService.sendSuspiciousActivityNotification,
    ).toHaveBeenCalledWith('user-id', 'session-id', {
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    });
  });

  it('detects reuse when concurrent rotation wins the atomic update race', async () => {
    prisma.session.findFirst
      .mockResolvedValueOnce({
        id: 'session-id',
        hashedRefreshToken: 'hash:incoming-token',
        expiresAt: new Date('2026-08-09T12:00:00.000Z'),
        user: { status: 'ACTIVE' },
      })
      .mockResolvedValueOnce({ hashedRefreshToken: 'hash:winning-token' });
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
    prisma.session.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.refresh('user-id', 'session-id', 'incoming-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(securityEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SUSPICIOUS_ACTIVITY_DETECTED',
        riskSignals: ['REFRESH_TOKEN_REUSE'],
      }),
    );
    expect(
      notificationService.sendSuspiciousActivityNotification,
    ).toHaveBeenCalledTimes(1);
  });

  it('still sends the notification when recording reuse fails', async () => {
    prisma.session.findFirst.mockResolvedValue({
      id: 'session-id',
      hashedRefreshToken: 'hash:current-token',
      expiresAt: new Date('2026-08-09T12:00:00.000Z'),
      user: { status: 'ACTIVE' },
    });
    securityEventService.record.mockRejectedValue(new Error('Database error'));

    await expect(
      service.refresh('user-id', 'session-id', 'old-token'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(
      notificationService.sendSuspiciousActivityNotification,
    ).toHaveBeenCalledTimes(1);
  });
});
