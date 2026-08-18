import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../../generated/prisma/client';
import { GeoIpService } from '../../../geo-ip/geo-ip.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';
import { SessionCreationService } from './session-creation.service';

jest.mock('crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

describe('SessionCreationService', () => {
  const inactivityTtlSeconds = 31_536_000;
  const activeSessionLimit = 10;
  const now = new Date('2026-08-08T12:00:00.000Z');
  const nextExpiresAt = new Date('2027-08-08T12:00:00.000Z');
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    session: {
      count: jest.fn(),
      create: jest.fn(),
    },
  };
  const jwtTokenService = { generateTokens: jest.fn() };
  const secureTokenService = {
    hash: jest.fn((token: string) => `hash:${token}`),
  };
  const geoIpService = { lookup: jest.fn() };
  const securityEventService = { record: jest.fn() };
  const riskAnalysisService = { assessNewSession: jest.fn() };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'SESSION_INACTIVITY_TTL_SECONDS') {
        return inactivityTtlSeconds;
      }

      if (key === 'SESSION_ACTIVE_LIMIT') {
        return activeSessionLimit;
      }

      throw new Error(`Unexpected configuration key: ${key}`);
    }),
  };

  let service: SessionCreationService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ status: 'ACTIVE' }]);
    prisma.session.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    riskAnalysisService.assessNewSession.mockResolvedValue({
      level: null,
      signals: [],
    });
    jwtTokenService.generateTokens.mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    geoIpService.lookup.mockReturnValue(null);

    service = new SessionCreationService(
      prisma as unknown as PrismaService,
      jwtTokenService as unknown as JwtTokenService,
      secureTokenService as unknown as SecureTokenService,
      geoIpService as unknown as GeoIpService,
      securityEventService as unknown as SecurityEventService,
      riskAnalysisService as unknown as RiskAnalysisService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates a session with expiration, metadata, risk, and events', async () => {
    geoIpService.lookup.mockReturnValue({ countryCode: 'CA', city: 'Toronto' });
    prisma.session.create.mockResolvedValue({});

    await expect(
      service.create('user-id', {
        ipAddress: '192.0.2.10',
        userAgent: 'Unicon/1.0 (iOS 18)',
        deviceModelIdentifier: 'iPhone17,1',
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        osVersion: '18.6',
        appVersion: '1.4.2',
      }),
    ).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      sessionId: '00000000-0000-4000-8000-000000000000',
    });

    expect(jwtTokenService.generateTokens).toHaveBeenCalledWith(
      'user-id',
      '00000000-0000-4000-8000-000000000000',
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
        deviceModelIdentifier: 'iPhone17,1',
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
      }),
      prisma,
    );
  });

  it('records and rejects an active-session limit failure', async () => {
    prisma.session.count.mockResolvedValue(activeSessionLimit);

    await expect(
      service.create('user-id'),
    ).rejects.toMatchObject<ConflictException>({
      response: {
        code: 'SESSION_LIMIT_REACHED',
        details: { activeSessionLimit },
      },
    });
    expect(prisma.session.create).not.toHaveBeenCalled();
    expect(securityEventService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'SESSION_CREATION_FAILED',
        reason: 'ACTIVE_SESSION_LIMIT_REACHED',
      }),
      prisma,
    );
  });

  it('rejects session creation when the locked user is not active', async () => {
    prisma.$queryRaw.mockResolvedValue([{ status: 'DELETION_SCHEDULED' }]);

    await expect(
      service.create('user-id'),
    ).rejects.toMatchObject<ForbiddenException>({
      response: {
        code: 'ACCOUNT_UNAVAILABLE',
      },
    });
    expect(prisma.session.count).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it('creates a prepared session in a caller-owned transaction', async () => {
    const preparedSession = await service.prepare('user-id', {
      platform: 'WEB',
    });

    await expect(
      service.createInTransaction(
        prisma as unknown as Prisma.TransactionClient,
        preparedSession,
      ),
    ).resolves.toEqual({ created: true });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.session.create).toHaveBeenCalledWith({
      data: preparedSession.data,
    });
  });

  it('retries a Prisma serializable transaction conflict', async () => {
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

    await expect(service.create('user-id')).resolves.toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('retries a driver-adapter transaction write conflict', async () => {
    const conflict = new Error('Transaction conflict.', {
      cause: { kind: 'TransactionWriteConflict' },
    });
    conflict.name = 'DriverAdapterError';
    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(
        (callback: (transaction: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );

    await expect(service.create('user-id')).resolves.toMatchObject({
      sessionId: '00000000-0000-4000-8000-000000000000',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('creates a session when GeoIP has no location', async () => {
    await service.create('user-id', { platform: 'UNKNOWN' });

    expect(prisma.session.create).toHaveBeenCalledWith({
      data: {
        id: '00000000-0000-4000-8000-000000000000',
        userId: 'user-id',
        hashedRefreshToken: 'hash:refresh-token',
        expiresAt: nextExpiresAt,
        ipAddress: undefined,
        userAgent: undefined,
        deviceModelIdentifier: undefined,
        deviceModel: undefined,
        platform: 'UNKNOWN',
        osVersion: undefined,
        appVersion: undefined,
        locationCountryCode: undefined,
        locationCity: undefined,
      },
    });
  });
});
