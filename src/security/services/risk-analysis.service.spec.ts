import { ConfigService } from '@nestjs/config';

import type { Prisma } from '../../generated/prisma/client';
import { RiskAnalysisService } from './risk-analysis.service';

describe('RiskAnalysisService', () => {
  const now = new Date('2026-08-09T12:00:00.000Z');
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, number> = {
        RISK_LOGIN_FAILURE_WINDOW_SECONDS: 900,
        RISK_LOGIN_FAILURE_THRESHOLD: 5,
        RISK_NEW_SESSION_WINDOW_SECONDS: 3600,
        RISK_NEW_SESSION_THRESHOLD: 3,
      };

      return values[key];
    }),
  };
  const securityEvent = {
    count: jest.fn(),
    findFirst: jest.fn(),
  };
  const client = { securityEvent } as unknown as Prisma.TransactionClient;

  let service: RiskAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RiskAnalysisService(
      configService as unknown as ConfigService,
    );
  });

  it('does not flag the first session or missing history', async () => {
    securityEvent.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await expect(
      service.assessNewSession(
        client,
        'user-id',
        {
          platform: 'IOS',
          deviceModel: 'iPhone 16 Pro',
          locationCountryCode: 'CA',
        },
        now,
      ),
    ).resolves.toEqual({ level: null, signals: [] });

    expect(securityEvent.findFirst).not.toHaveBeenCalled();
  });

  it('classifies a new device and country together as medium risk', async () => {
    securityEvent.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    securityEvent.findFirst.mockResolvedValue(null);

    await expect(
      service.assessNewSession(
        client,
        'user-id',
        {
          platform: 'ANDROID',
          deviceModel: 'Pixel 10',
          locationCountryCode: 'US',
        },
        now,
      ),
    ).resolves.toEqual({
      level: 'MEDIUM',
      signals: ['NEW_DEVICE', 'NEW_COUNTRY'],
    });
  });

  it('classifies combined credential and session velocity as high risk', async () => {
    securityEvent.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(2);
    securityEvent.findFirst.mockResolvedValue({ id: 'known-event' });

    await expect(
      service.assessNewSession(
        client,
        'user-id',
        {
          platform: 'IOS',
          deviceModel: 'Known phone',
          locationCountryCode: 'CA',
        },
        now,
      ),
    ).resolves.toEqual({
      level: 'HIGH',
      signals: ['EXCESSIVE_LOGIN_FAILURES', 'MANY_NEW_SESSIONS'],
    });
  });

  it('does not treat missing or unknown device metadata as a new device', async () => {
    securityEvent.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await expect(
      service.assessNewSession(client, 'user-id', { platform: 'UNKNOWN' }, now),
    ).resolves.toEqual({ level: null, signals: [] });
  });

  it('classifies refresh-token reuse as high risk', () => {
    expect(service.refreshTokenReuse()).toEqual({
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    });
  });
});
