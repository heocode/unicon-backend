import { ConfigService } from '@nestjs/config';
import { Prisma, type GcraRateLimit } from '../../../generated/prisma/client';

import { RateLimitBucketKeyService } from '../../../rate-limit/services/rate-limit-bucket-key.service';
import { createGcraState } from '../../../rate-limit/utils/gcra-state.util';
import { toGcraPersistenceData } from '../../../rate-limit/utils/gcra-state-persistence.util';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../constants/authentication-rate-limit-policies.constants';
import type { AuthenticationDeliveryCooldownAlias } from '../types/authentication-delivery-rate-limit.type';
import { AuthenticationDeliveryRateLimitService } from './authentication-delivery-rate-limit.service';
import { AuthenticationRateLimitConfigService } from './authentication-rate-limit-config.service';

function configValues() {
  return {
    RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 2,
    RATE_LIMIT_HMAC_KEYS: new Map([
      [1, Buffer.alloc(32, 4)],
      [2, Buffer.alloc(32, 5)],
    ]),
    AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS: 60,
    AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS: 60,
    AUTH_DELIVERY_IDENTITY_BURST: 10,
    AUTH_DELIVERY_IDENTITY_RATE: 7,
    AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS: 3600,
    AUTH_DELIVERY_IP_BURST: 120,
    AUTH_DELIVERY_IP_RATE: 240,
    AUTH_DELIVERY_IP_PERIOD_SECONDS: 3600,
    AUTH_VERIFICATION_IDENTITY_SHORT_BURST: 6,
    AUTH_VERIFICATION_IDENTITY_SHORT_RATE: 6,
    AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS: 60,
    AUTH_VERIFICATION_IP_SHORT_BURST: 72,
    AUTH_VERIFICATION_IP_SHORT_RATE: 72,
    AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS: 60,
    AUTH_VERIFICATION_IDENTITY_LONG_BURST: 8,
    AUTH_VERIFICATION_IDENTITY_LONG_RATE: 12,
    AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS: 3600,
    AUTH_VERIFICATION_IP_LONG_BURST: 360,
    AUTH_VERIFICATION_IP_LONG_RATE: 360,
    AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS: 3600,
  };
}

const input = {
  challengeId: '123e4567-e89b-42d3-a456-426614174000',
  normalizedIdentity: 'student@example.edu',
  ipAddress: '192.0.2.1',
};

function setup(now = 0n) {
  const config = new ConfigService(configValues());
  config.skipProcessEnv = true;
  const policyConfig = new AuthenticationRateLimitConfigService(config);
  const derivation = new RateLimitBucketKeyService(config);
  const gcra = {
    isolationLevel: jest.fn(() => Promise.resolve('read committed')),
    lockAliases: jest.fn(() => Promise.resolve()),
    readAliases: jest.fn(() => Promise.resolve<GcraRateLimit[]>([])),
    operationNowMicros: jest.fn(() => Promise.resolve(now)),
    writeAliases: jest.fn(() => Promise.resolve()),
  };
  const cooldown = {
    readAliases: jest.fn(() =>
      Promise.resolve<AuthenticationDeliveryCooldownAlias[]>([]),
    ),
    writeAliases: jest.fn(() => Promise.resolve()),
  };
  const transaction = {
    $executeRaw: jest.fn(() => Promise.resolve(0)),
  } as unknown as Prisma.TransactionClient;
  const service = new AuthenticationDeliveryRateLimitService(
    policyConfig,
    derivation,
    gcra,
    cooldown,
  );
  const challengeKeys = derivation
    .deriveKeys(policies.challengeDeliveryCooldown, input.challengeId)
    .buckets.map((b) => b.key);
  const identityKeys = derivation
    .deriveKeys(policies.identityDeliveryCooldown, input.normalizedIdentity)
    .buckets.map((b) => b.key);
  return {
    service,
    transaction,
    gcra,
    cooldown,
    derivation,
    policyConfig,
    challengeKeys,
    identityKeys,
  };
}

describe('AuthenticationDeliveryRateLimitService (unit)', () => {
  it('checks the full union before any charge and uses one time sample', async () => {
    const {
      service,
      transaction,
      gcra,
      cooldown,
      challengeKeys,
      identityKeys,
    } = setup(123_456n);
    expect(await service.admitInTransaction(transaction, input)).toEqual({
      allowed: true,
      operationNowMicros: 123_456n,
    });
    expect(gcra.lockAliases).toHaveBeenCalledTimes(1);
    expect(gcra.lockAliases).toHaveBeenCalledWith(
      transaction,
      expect.arrayContaining([...challengeKeys, ...identityKeys]),
    );
    expect(gcra.operationNowMicros).toHaveBeenCalledTimes(1);
    expect(cooldown.readAliases.mock.invocationCallOrder[0]).toBeLessThan(
      gcra.operationNowMicros.mock.invocationCallOrder[0],
    );
    expect(gcra.operationNowMicros.mock.invocationCallOrder[0]).toBeLessThan(
      gcra.writeAliases.mock.invocationCallOrder[0],
    );
    expect(gcra.writeAliases).toHaveBeenCalledTimes(2);
    expect(cooldown.writeAliases).toHaveBeenCalledTimes(2);
    expect(cooldown.writeAliases).toHaveBeenCalledWith(
      transaction,
      challengeKeys,
      60_123_456n,
    );
    expect(cooldown.writeAliases).toHaveBeenCalledWith(
      transaction,
      identityKeys,
      60_123_456n,
    );
  });

  it.each([
    { now: 6_000_000n, wait: 54n },
    { now: 59_999_999n, wait: 1n },
  ])('denies at $now without moving either boundary', async ({ now, wait }) => {
    const {
      service,
      transaction,
      gcra,
      cooldown,
      challengeKeys,
      identityKeys,
    } = setup(now);
    cooldown.readAliases.mockResolvedValue([
      { key: challengeKeys[0], count: 1, windowEndAtMicros: '60000000' },
      { key: identityKeys[1], count: 1, windowEndAtMicros: '60000000' },
    ]);
    expect(await service.admitInTransaction(transaction, input)).toEqual({
      allowed: false,
      operationNowMicros: now,
      retryAfterSeconds: wait,
      deniedPolicyIds: [
        policies.challengeDeliveryCooldown.id,
        policies.identityDeliveryCooldown.id,
      ],
    });
    expect(gcra.writeAliases).not.toHaveBeenCalled();
    expect(cooldown.writeAliases).not.toHaveBeenCalled();
  });

  it.each([60_000_000n, 60_000_001n])(
    'allows at or after the exact boundary %s',
    async (now) => {
      const { service, transaction, cooldown, identityKeys } = setup(now);
      cooldown.readAliases.mockResolvedValue([
        { key: identityKeys[0], count: 1, windowEndAtMicros: '60000000' },
      ]);
      expect(
        (await service.admitInTransaction(transaction, input)).allowed,
      ).toBe(true);
      expect(cooldown.writeAliases).toHaveBeenCalledWith(
        transaction,
        identityKeys,
        now + 60_000_000n,
      );
    },
  );

  it('uses the latest retained cooldown alias', async () => {
    const { service, transaction, cooldown, identityKeys } = setup(6_000_000n);
    cooldown.readAliases.mockResolvedValue([
      { key: identityKeys[0], count: 1, windowEndAtMicros: '60000000' },
      { key: identityKeys[1], count: 1, windowEndAtMicros: '90000000' },
    ]);
    expect(await service.admitInTransaction(transaction, input)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 84n,
    });
    expect(cooldown.writeAliases).not.toHaveBeenCalled();
  });

  it('combines cooldown and GCRA denials without spending either budget', async () => {
    const {
      service,
      transaction,
      gcra,
      cooldown,
      identityKeys,
      derivation,
      policyConfig,
    } = setup();
    const key = derivation.deriveKeys(
      policies.deliveryIdentity,
      input.normalizedIdentity,
    ).buckets[0].key;
    const data = toGcraPersistenceData(
      createGcraState(
        { numerator: 36_000_000_000n, denominator: 7n },
        policyConfig.deliveryIdentity,
      ),
    );
    gcra.readAliases.mockResolvedValue([
      {
        ...data,
        key,
        policyId: policies.deliveryIdentity.id,
        updatedAt: new Date(0),
        tatNumerator: new Prisma.Decimal(data.tatNumerator),
        tatDenominator: new Prisma.Decimal(data.tatDenominator),
        idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
      },
    ]);
    cooldown.readAliases.mockResolvedValue([
      { key: identityKeys[0], count: 1, windowEndAtMicros: '60000000' },
    ]);
    expect(await service.admitInTransaction(transaction, input)).toEqual({
      allowed: false,
      operationNowMicros: 0n,
      retryAfterSeconds: 515n,
      deniedPolicyIds: [
        policies.deliveryIdentity.id,
        policies.identityDeliveryCooldown.id,
      ],
    });
    expect(gcra.writeAliases).not.toHaveBeenCalled();
    expect(cooldown.writeAliases).not.toHaveBeenCalled();
  });

  it.each([
    { count: 2, windowEndAtMicros: '-1' },
    { count: 1, windowEndAtMicros: null },
    { count: 1, windowEndAtMicros: 'NaN' },
  ])('rejects invalid cooldown state %p without repair', async (row) => {
    const { service, transaction, gcra, cooldown, identityKeys } = setup();
    cooldown.readAliases.mockResolvedValue([{ key: identityKeys[0], ...row }]);
    await expect(
      service.admitInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(gcra.writeAliases).not.toHaveBeenCalled();
    expect(cooldown.writeAliases).not.toHaveBeenCalled();
  });

  it('rolls back its savepoint when a later cooldown write fails', async () => {
    const { service, transaction, gcra, cooldown } = setup();
    cooldown.writeAliases
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Private database failure.'));
    await expect(
      service.admitInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(gcra.writeAliases).toHaveBeenCalledTimes(2);
    expect(cooldown.writeAliases).toHaveBeenCalledTimes(2);
    expect(transaction.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining(['ROLLBACK TO SAVEPOINT unicon_gcra_admission']),
    );
  });

  it.each([
    { ...input, challengeId: 'invalid' },
    { ...input, normalizedIdentity: 'Student@example.edu' },
    { ...input, ipAddress: undefined },
  ])('rejects invalid internal context without bucket locks', async (value) => {
    const { service, transaction, gcra } = setup();
    await expect(
      service.admitInTransaction(transaction, value),
    ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    expect(gcra.lockAliases).not.toHaveBeenCalled();
  });
});
