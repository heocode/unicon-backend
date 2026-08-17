import { ConfigService } from '@nestjs/config';

import { GeoIpService } from '../../geo-ip/geo-ip.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from './security-event.service';

describe('SecurityEventService', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  const prisma = {
    securityEvent: {
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const geoIpService = {
    lookup: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn(() => 15_552_000),
  };

  let service: SecurityEventService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    service = new SecurityEventService(
      prisma as unknown as PrismaService,
      geoIpService as unknown as GeoIpService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('records an append-only event with its retention deadline', async () => {
    prisma.securityEvent.create.mockResolvedValue({ id: 'event-id' });

    await expect(
      service.record({
        type: 'LOGIN_FAILED',
        reason: 'INVALID_CREDENTIALS',
        ipAddress: '192.0.2.10',
      }),
    ).resolves.toEqual({ id: 'event-id' });

    expect(prisma.securityEvent.create).toHaveBeenCalledWith({
      data: {
        type: 'LOGIN_FAILED',
        reason: 'INVALID_CREDENTIALS',
        ipAddress: '192.0.2.10',
        occurredAt: now,
        retentionExpiresAt: new Date('2027-02-05T12:00:00.000Z'),
      },
      select: { id: true },
    });
  });

  it('uses the provided transaction client', async () => {
    const transaction = {
      securityEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-id' }),
      },
    };

    await service.record(
      { type: 'SESSION_CREATED', userId: 'user-id' },
      transaction as never,
    );

    expect(transaction.securityEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.securityEvent.create).not.toHaveBeenCalled();
  });

  it('creates a bounded request and GeoIP snapshot', () => {
    geoIpService.lookup.mockReturnValue({ countryCode: 'CA', city: 'Toronto' });

    expect(
      service.snapshotFromMetadata({
        platform: 'IOS',
        ipAddress: '192.0.2.10',
        deviceModel: 'iPhone 16 Pro',
      }),
    ).toEqual({
      platform: 'IOS',
      ipAddress: '192.0.2.10',
      deviceModel: 'iPhone 16 Pro',
      locationCountryCode: 'CA',
      locationCity: 'Toronto',
    });
  });

  it('deletes events whose retention deadline has passed', async () => {
    prisma.securityEvent.deleteMany.mockResolvedValue({ count: 4 });

    await expect(service.deleteExpired(now)).resolves.toBe(4);
    expect(prisma.securityEvent.deleteMany).toHaveBeenCalledWith({
      where: { retentionExpiresAt: { lte: now } },
    });
  });
});
