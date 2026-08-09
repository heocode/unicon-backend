import { ConfigService } from '@nestjs/config';
import type { ReaderModel } from '@maxmind/geoip2-node';
import { GeoIpService } from './geo-ip.service';

describe('GeoIpService', () => {
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'GEOIP_ENABLED') {
        return true;
      }

      if (key === 'GEOIP_RELOAD_INTERVAL_SECONDS') {
        return 60;
      }

      return 'data/geoip/GeoLite2-City.mmdb';
    }),
  };
  const databaseLoader = {
    getFingerprint: jest.fn(),
    load: jest.fn(),
  };

  let service: GeoIpService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    service = new GeoIpService(
      configService as unknown as ConfigService,
      databaseLoader,
    );
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
  });

  it('loads the database and returns country and city', async () => {
    databaseLoader.getFingerprint.mockResolvedValue('version-1');
    databaseLoader.load.mockResolvedValue(createReader('CA', 'Toronto'));

    await service.onModuleInit();

    expect(service.lookup('8.8.8.8')).toEqual({
      countryCode: 'CA',
      city: 'Toronto',
    });
  });

  it('loads a database that appears after application startup', async () => {
    databaseLoader.getFingerprint
      .mockResolvedValueOnce(null)
      .mockResolvedValue('version-1');
    databaseLoader.load.mockResolvedValue(createReader('CA', 'Toronto'));

    await service.onModuleInit();
    expect(service.lookup('8.8.8.8')).toBeNull();

    await jest.advanceTimersByTimeAsync(60_000);

    expect(service.lookup('8.8.8.8')).toEqual({
      countryCode: 'CA',
      city: 'Toronto',
    });
  });

  it('atomically replaces the reader when the database changes', async () => {
    databaseLoader.getFingerprint
      .mockResolvedValueOnce('version-1')
      .mockResolvedValue('version-2');
    databaseLoader.load
      .mockResolvedValueOnce(createReader('CA', 'Toronto'))
      .mockResolvedValue(createReader('US', 'New York'));

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(service.lookup('8.8.8.8')).toEqual({
      countryCode: 'US',
      city: 'New York',
    });
  });

  it('keeps the previous reader when an updated database is invalid', async () => {
    databaseLoader.getFingerprint
      .mockResolvedValueOnce('version-1')
      .mockResolvedValue('version-2');
    databaseLoader.load
      .mockResolvedValueOnce(createReader('CA', 'Toronto'))
      .mockRejectedValue(new Error('Invalid database'));

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(service.lookup('8.8.8.8')).toEqual({
      countryCode: 'CA',
      city: 'Toronto',
    });
  });

  it('does not reload an unchanged database', async () => {
    databaseLoader.getFingerprint.mockResolvedValue('version-1');
    databaseLoader.load.mockResolvedValue(createReader('CA', 'Toronto'));

    await service.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(databaseLoader.load).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the module is destroyed', async () => {
    databaseLoader.getFingerprint.mockResolvedValue(null);

    await service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);

    service.onModuleDestroy();

    expect(jest.getTimerCount()).toBe(0);
  });
});

function createReader(
  countryCode: string,
  city: string | null,
): Pick<ReaderModel, 'city'> {
  return {
    city: jest.fn().mockReturnValue({
      country: { isoCode: countryCode },
      city: city ? { names: { en: city } } : undefined,
    }),
  };
}
