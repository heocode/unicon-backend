import { createHmac } from 'crypto';

import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountDeletionCancellationRateLimitService } from './account-deletion-cancellation-rate-limit.service';

describe('AccountDeletionCancellationRateLimitService', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');
  const rateLimit = {
    findUnique: jest.fn(),
    upsert: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(),
    accountDeletionCancellationRateLimit: rateLimit,
  };
  const values: Record<string, string | number> = {
    ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS: 900,
    ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL: 2,
    ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP: 3,
    ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET: 'rate-limit-secret',
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => values[key]),
  };

  let service: AccountDeletionCancellationRateLimitService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (transaction: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    rateLimit.findUnique.mockResolvedValue(null);
    rateLimit.upsert.mockResolvedValue({});
    rateLimit.update.mockResolvedValue({});
    rateLimit.deleteMany.mockResolvedValue({ count: 2 });

    service = new AccountDeletionCancellationRateLimitService(
      prisma as unknown as PrismaService,
      configService as unknown as ConfigService,
    );
  });

  afterEach(() => jest.useRealTimers());

  it('stores an HMAC bucket key without the raw normalized email', async () => {
    await expect(service.consumeEmail('student@example.edu')).resolves.toEqual({
      allowed: true,
    });

    const digest = createHmac('sha256', 'rate-limit-secret')
      .update('student@example.edu')
      .digest('hex');
    expect(rateLimit.upsert).toHaveBeenCalledWith({
      where: { key: `email:${digest}` },
      create: {
        key: `email:${digest}`,
        count: 1,
        windowEndAt: new Date('2026-08-17T12:15:00.000Z'),
      },
      update: {
        count: 1,
        windowEndAt: new Date('2026-08-17T12:15:00.000Z'),
      },
    });
    expect(JSON.stringify(rateLimit.upsert.mock.calls)).not.toContain(
      'student@example.edu',
    );
  });

  it('uses a separate unknown-IP bucket when no IP is available', async () => {
    await service.consumeIp(undefined);

    const digest = createHmac('sha256', 'rate-limit-secret')
      .update('unknown')
      .digest('hex');
    expect(rateLimit.findUnique).toHaveBeenCalledWith({
      where: { key: `ip:${digest}` },
    });
  });

  it('increments an active bucket below its limit', async () => {
    rateLimit.findUnique.mockResolvedValue({
      count: 1,
      windowEndAt: new Date('2026-08-17T12:10:00.000Z'),
    });

    await expect(service.consumeEmail('student@example.edu')).resolves.toEqual({
      allowed: true,
    });
    const digest = createHmac('sha256', 'rate-limit-secret')
      .update('student@example.edu')
      .digest('hex');
    expect(rateLimit.update).toHaveBeenCalledWith({
      where: { key: `email:${digest}` },
      data: { count: { increment: 1 } },
    });
  });

  it('returns the remaining fixed-window cooldown at the limit', async () => {
    rateLimit.findUnique.mockResolvedValue({
      count: 2,
      windowEndAt: new Date('2026-08-17T12:02:00.100Z'),
    });

    await expect(service.consumeEmail('student@example.edu')).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 121,
    });
    expect(rateLimit.update).not.toHaveBeenCalled();
  });

  it('starts a new window when the previous bucket expired', async () => {
    rateLimit.findUnique.mockResolvedValue({
      count: 100,
      windowEndAt: now,
    });

    await expect(service.consumeIp('192.0.2.10')).resolves.toEqual({
      allowed: true,
    });
    expect(rateLimit.upsert).toHaveBeenCalled();
  });

  it('retries a serialization conflict', async () => {
    prisma.$transaction
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Conflict', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      )
      .mockImplementationOnce(
        (callback: (transaction: typeof prisma) => Promise<unknown>) =>
          callback(prisma),
      );

    await expect(service.consumeEmail('student@example.edu')).resolves.toEqual({
      allowed: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('deletes expired buckets only', async () => {
    await expect(service.deleteExpired(now)).resolves.toBe(2);
    expect(rateLimit.deleteMany).toHaveBeenCalledWith({
      where: { windowEndAt: { lte: now } },
    });
  });
});
