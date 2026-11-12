import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client';
import { AuthenticationChallengeConfigService } from '../src/auth/challenge/services/authentication-challenge-config.service';
import { AuthenticationChallengeProofService } from '../src/auth/challenge/services/authentication-challenge-proof.service';
import { AuthenticationChallengeProofEncryptionService } from '../src/auth/challenge/services/authentication-challenge-proof-encryption.service';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationChallengeRandomSourceService } from '../src/auth/challenge/services/authentication-challenge-random-source.service';

import { AuthenticationDeliveryRateLimitService } from '../src/auth/rate-limit/services/authentication-delivery-rate-limit.service';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import type { AuthenticationDeliveryRateLimitInput } from '../src/auth/rate-limit/types/authentication-delivery-rate-limit.type';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import {
  chargeGcra,
  evaluateGcra,
} from '../src/rate-limit/utils/gcra-state.util';
import {
  fromGcraPersistenceData,
  toGcraPersistenceData,
} from '../src/rate-limit/utils/gcra-state-persistence.util';
import type { GcraState } from '../src/rate-limit/types/gcra-state.type';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';

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

describe('Authentication Delivery cooldown and GCRA (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const gcraRepository = new GcraAdmissionRepository();
  const cooldownRepository = new AuthenticationDeliveryCooldownRepository();
  const ownedKeys = new Set<string>();
  const ownedSubjects = new Set<string>();
  const replicaBName = `delivery_cooldown_b_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let configA: ConfigService;
  let configB: ConfigService;
  let serviceA: AuthenticationDeliveryRateLimitService;
  let serviceB: AuthenticationDeliveryRateLimitService;

  function service(config: ConfigService) {
    return new AuthenticationDeliveryRateLimitService(
      new AuthenticationRateLimitConfigService(config),
      new RateLimitBucketKeyService(config),
      gcraRepository,
      cooldownRepository,
    );
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test'))
      throw new Error('Cooldown tests require a dedicated test database.');
    const secondUrl = new URL(url);
    secondUrl.searchParams.set('application_name', replicaBName);
    configA = new ConfigService({ ...configValues(), DATABASE_URL: url });
    configB = new ConfigService({
      ...configValues(),
      RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 1,
      DATABASE_URL: secondUrl.toString(),
    });
    configA.skipProcessEnv = true;
    configB.skipProcessEnv = true;
    prismaA = new PrismaService(configA);
    prismaB = new PrismaService(configB);
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    serviceA = service(configA);
    serviceB = service(configB);
  });

  afterEach(async () => {
    await prismaA.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prismaA.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prismaA.authenticationChallengeSubject.deleteMany({
      where: { key: { in: [...ownedSubjects] } },
    });
    ownedKeys.clear();
    ownedSubjects.clear();
  });

  afterAll(async () => {
    await Promise.all([prismaA?.$disconnect(), prismaB?.$disconnect()]);
  });

  function input(
    overrides: Partial<AuthenticationDeliveryRateLimitInput> = {},
  ): AuthenticationDeliveryRateLimitInput {
    const result = {
      challengeId: randomUUID(),
      normalizedIdentity: `cooldown-${randomUUID()}@example.edu`,
      ipAddress: '192.0.2.1',
      ...overrides,
    };
    keys(result);
    return result;
  }

  function keys(value: AuthenticationDeliveryRateLimitInput) {
    const derivation = new RateLimitBucketKeyService(configA);
    const result = {
      challenge: derivation
        .deriveKeys(policies.challengeDeliveryCooldown, value.challengeId)
        .buckets.map((b) => b.key),
      identity: derivation
        .deriveKeys(policies.identityDeliveryCooldown, value.normalizedIdentity)
        .buckets.map((b) => b.key),
      emailGcra: derivation
        .deriveKeys(policies.deliveryIdentity, value.normalizedIdentity)
        .buckets.map((b) => b.key),
      ipGcra: derivation
        .deriveKeys(policies.deliveryIp, value.ipAddress)
        .buckets.map((b) => b.key),
    };
    Object.values(result)
      .flat()
      .forEach((key) => ownedKeys.add(key));
    return result;
  }

  async function admit(
    value: AuthenticationDeliveryRateLimitInput,
    other = false,
  ) {
    return (other ? prismaB : prismaA).$transaction(
      (tx) => (other ? serviceB : serviceA).admitInTransaction(tx, value),
      { timeout: 10_000 },
    );
  }

  async function now(tx: Prisma.TransactionClient = prismaA) {
    const [row] = await tx.$queryRaw<
      { value: string }[]
    >`SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::text AS value`;
    return BigInt(row.value);
  }

  async function snapshot(value: AuthenticationDeliveryRateLimitInput) {
    const all = Object.values(keys(value)).flat();
    const cd = await prismaA.$queryRaw<
      { key: string; count: number; boundary: string; updated: string }[]
    >(Prisma.sql`
      SELECT "key","count","windowEndAt"::text AS boundary,"updatedAt"::text AS updated
      FROM "AuthenticationRateLimit" WHERE "key" IN (${Prisma.join(all)}) ORDER BY "key"
    `);
    const gcra = await prismaA.gcraRateLimit.findMany({
      where: { key: { in: all } },
      orderBy: { key: 'asc' },
    });
    return { cd, gcra };
  }

  async function seedCooldown(aliasKeys: string[], boundary: bigint) {
    await prismaA.$transaction((tx) =>
      cooldownRepository.writeAliases(tx, aliasKeys, boundary),
    );
  }

  it('writes count=1 and exact microsecond boundaries together with one GCRA charge per policy', async () => {
    const value = input();
    const result = await admit(value);
    expect(result.allowed).toBe(true);
    const alias = keys(value);
    const cooldowns = await prismaA.$transaction((tx) =>
      cooldownRepository.readAliases(tx, [
        ...alias.challenge,
        ...alias.identity,
      ]),
    );
    expect(cooldowns).toHaveLength(4);
    cooldowns.forEach((row) => {
      expect(row.count).toBe(1);
      expect(row.windowEndAtMicros).toBe(
        (result.operationNowMicros + 60_000_000n).toString(),
      );
    });
    const gcra = (await snapshot(value)).gcra;
    expect(gcra).toHaveLength(4);
    const policyConfig = new AuthenticationRateLimitConfigService(configA);
    gcra.forEach((row) =>
      expect(fromGcraPersistenceData(row)).toEqual(
        chargeGcra(
          null,
          row.policyId === policies.deliveryIdentity.id
            ? policyConfig.deliveryIdentity
            : policyConfig.deliveryIp,
          result.operationNowMicros,
        ),
      ),
    );
    const [column] = await prismaA.$queryRaw<
      { datetime_precision: number }[]
    >`SELECT datetime_precision FROM information_schema.columns WHERE table_schema='public' AND table_name='AuthenticationRateLimit' AND column_name='windowEndAt'`;
    expect(column.datetime_precision).toBe(6);
  });

  it('round-trips six-digit microseconds independently of the PostgreSQL session timezone', async () => {
    const value = input();
    const alias = keys(value).identity;
    const boundary = 1_800_000_000_123_457n;
    await prismaA.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'America/Toronto'`;
      await cooldownRepository.writeAliases(tx, alias, boundary);
      const rows = await cooldownRepository.readAliases(tx, alias);
      rows.forEach((row) =>
        expect(row.windowEndAtMicros).toBe(boundary.toString()),
      );
    });
    const rows = await prismaA.$transaction((tx) =>
      cooldownRepository.readAliases(tx, alias),
    );
    rows.forEach((row) =>
      expect(row.windowEndAtMicros).toBe(boundary.toString()),
    );
  });

  it('denies repeated attempts without moving boundaries, quota state or audit timestamps', async () => {
    const value = input();
    await admit(value);
    const before = await snapshot(value);
    const boundary = await prismaA.$transaction(
      async (tx) =>
        (await cooldownRepository.readAliases(tx, keys(value).identity))[0]
          .windowEndAtMicros,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await admit(value, true);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        const wait = BigInt(boundary!) - result.operationNowMicros;
        expect(result.retryAfterSeconds).toBe((wait + 999_999n) / 1_000_000n);
        expect(result.deniedPolicyIds).toEqual([
          policies.challengeDeliveryCooldown.id,
          policies.identityDeliveryCooldown.id,
        ]);
      }
    }
    expect(await snapshot(value)).toEqual(before);
  });

  it('serializes different challenges and source IPs of one identity across two replicas', async () => {
    const first = input();
    const contexts = Array.from({ length: 20 }, (_, index) =>
      input({
        normalizedIdentity: first.normalizedIdentity,
        ipAddress: `192.0.2.${index + 1}`,
      }),
    );
    const results = await Promise.all(
      contexts.map(async (value, index) => ({
        value,
        result: await admit(value, index % 2 === 0),
      })),
    );
    const winners = results.filter(({ result }) => result.allowed);
    expect(winners).toHaveLength(1);
    for (const { value, result } of results) {
      if (result.allowed) continue;
      const cd = (await snapshot(value)).cd;
      expect(cd).toHaveLength(2);
      expect(cd.every((row) => keys(value).identity.includes(row.key))).toBe(
        true,
      );
      expect(result.deniedPolicyIds).toContain(
        policies.identityDeliveryCooldown.id,
      );
      expect(
        await prismaA.gcraRateLimit.count({
          where: { key: { in: keys(value).ipGcra } },
        }),
      ).toBe(0);
    }
    const winner = winners[0];
    expect((await snapshot(winner.value)).gcra).toHaveLength(4);
  });

  it('does not bypass identity cooldown by changing challenge, IP, or caller context', async () => {
    const first = input();
    await admit(first);
    const replacement = input({
      normalizedIdentity: first.normalizedIdentity,
      ipAddress: '192.0.2.2',
    });
    const result = await admit(replacement);
    expect(result.allowed).toBe(false);
    if (!result.allowed)
      expect(result.deniedPolicyIds).toEqual([
        policies.identityDeliveryCooldown.id,
      ]);
    const original = await snapshot(first);
    expect(original.cd).toHaveLength(4);
    expect((await snapshot(replacement)).cd).toHaveLength(2);
    expect(
      await prismaA.authenticationRateLimit.count({
        where: { key: { in: keys(replacement).challenge } },
      }),
    ).toBe(0);
  });

  it('allows another identity immediately while retaining the first identity interval', async () => {
    const first = input();
    await admit(first);
    expect((await admit(input())).allowed).toBe(true);
    expect((await admit(first)).allowed).toBe(false);
  });

  it('preserves an existing longer interval after configuration changes', async () => {
    const value = input();
    const aliases = keys(value);
    const boundary = (await now()) + 120_000_000n;
    await seedCooldown(aliases.challenge, boundary);
    await seedCooldown(aliases.identity, (await now()) - 1n);
    const before = await snapshot(value);
    const result = await admit(value);
    expect(result.allowed).toBe(false);
    if (!result.allowed)
      expect(result.deniedPolicyIds).toEqual([
        policies.challengeDeliveryCooldown.id,
      ]);
    expect(await snapshot(value)).toEqual(before);
  });

  it.each(['challenge', 'identity'] as const)(
    'retains %s cooldown from a missing/old alias after key promotion',
    async (kind) => {
      const value = input();
      const alias = keys(value)[kind];
      const boundary = (await now()) + 60_000_001n;
      await seedCooldown([alias[0]], boundary);
      const before = await snapshot(value);
      const result = await admit(value);
      expect(result.allowed).toBe(false);
      expect(await snapshot(value)).toEqual(before);
    },
  );

  it('reconciles the latest retained boundary and does not materialize missing work on denial', async () => {
    const value = input();
    const alias = keys(value);
    const t = await now();
    await seedCooldown([alias.identity[0]], t + 60_000_000n);
    await seedCooldown([alias.identity[1]], t + 90_000_000n);
    const before = await snapshot(value);
    const result = await admit(value);
    expect(result.allowed).toBe(false);
    if (!result.allowed)
      expect(result.retryAfterSeconds).toBe(
        (t + 90_000_000n - result.operationNowMicros + 999_999n) / 1_000_000n,
      );
    expect(await snapshot(value)).toEqual(before);
  });

  it('re-establishes both boundaries only after expired cooldown and mirrors absent aliases', async () => {
    const value = input();
    const alias = keys(value);
    const expired = (await now()) - 1n;
    await seedCooldown([alias.challenge[0]], expired);
    await seedCooldown([alias.identity[1]], expired);
    const result = await admit(value);
    expect(result.allowed).toBe(true);
    expect((await snapshot(value)).cd).toHaveLength(4);
    const rows = await prismaA.$transaction((tx) =>
      cooldownRepository.readAliases(tx, [
        ...alias.challenge,
        ...alias.identity,
      ]),
    );
    rows.forEach((row) =>
      expect(row.windowEndAtMicros).toBe(
        (result.operationNowMicros + 60_000_000n).toString(),
      ),
    );
  });

  it.each(['emailGcra', 'ipGcra'] as const)(
    'does not start any cooldown if %s denies',
    async (kind) => {
      const value = input();
      const pc = new AuthenticationRateLimitConfigService(configA);
      const settings =
        kind === 'emailGcra' ? pc.deliveryIdentity : pc.deliveryIp;
      const policyId =
        kind === 'emailGcra'
          ? policies.deliveryIdentity.id
          : policies.deliveryIp.id;
      const t = await now();
      let state: GcraState | null = null;
      for (let index = 0; index < settings.burst; index++)
        state = chargeGcra(state, settings, t);
      await prismaA.gcraRateLimit.create({
        data: {
          key: keys(value)[kind][0],
          policyId,
          ...toGcraPersistenceData(state!),
        },
      });
      const before = await snapshot(value);
      const result = await admit(value);
      expect(result.allowed).toBe(false);
      if (!result.allowed)
        expect(result.retryAfterSeconds).toBe(
          evaluateGcra(state, settings, result.operationNowMicros)
            .retryAfterSeconds,
        );
      expect(await snapshot(value)).toEqual(before);
    },
  );

  it.each(['count', 'infinity'] as const)(
    'fails closed on corrupt cooldown %s without charging any policy',
    async (kind) => {
      const value = input();
      const key = keys(value).identity[0];
      await seedCooldown([key], (await now()) + 60_000_000n);
      if (kind === 'count')
        await prismaA.authenticationRateLimit.update({
          where: { key },
          data: { count: 2 },
        });
      else
        await prismaA.$executeRaw`UPDATE "AuthenticationRateLimit" SET "windowEndAt" = 'infinity'::timestamp WHERE "key" = ${key}`;
      const before = await snapshot(value);
      await expect(admit(value)).rejects.toMatchObject({
        reason: 'INVALID_STATE',
      });
      expect(await snapshot(value)).toEqual(before);
    },
  );

  it('does not lock, consume, expire or alter a real challenge and its encrypted proof', async () => {
    const value = input();
    const challengeConfig = new AuthenticationChallengeConfigService(
      new ConfigService({
        AUTH_CHALLENGE_TTL_SECONDS: 600,
        AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
        AUTH_CHALLENGE_RETENTION_SECONDS: 86400,
        AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS: 60,
        AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: 100,
        AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN: 10,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_HMAC_KEYS: new Map([[1, Buffer.alloc(32, 1)]]),
        AUTH_CHALLENGE_ENCRYPTION_KEYS: new Map([[1, Buffer.alloc(32, 2)]]),
      }),
    );
    const random = new AuthenticationChallengeRandomSourceService();
    const factory = new AuthenticationChallengeProofFactoryService(
      new AuthenticationChallengeProofService(challengeConfig, random),
      new AuthenticationChallengeProofEncryptionService(
        challengeConfig,
        random,
      ),
    );
    const proof = factory.generate({
      challengeId: value.challengeId,
      purpose: 'SIGN_IN',
      normalizedIdentity: value.normalizedIdentity,
    });
    const subjectKey = `cooldown-proof-${randomUUID()}`;
    ownedSubjects.add(subjectKey);
    const before = await prismaA.authenticationChallenge.create({
      data: {
        id: value.challengeId,
        subject: { create: { key: subjectKey } },
        identityType: 'INSTITUTIONAL_EMAIL',
        purpose: 'SIGN_IN',
        normalizedIdentity: value.normalizedIdentity,
        ...proof.persistence.hashing,
        ...proof.persistence.encryption,
        expiresAt: new Date(Date.now() + 600_000),
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
        maxAttempts: 5,
      },
    });
    expect((await admit(value)).allowed).toBe(true);
    expect((await admit(value, true)).allowed).toBe(false);
    expect(
      await prismaA.authenticationChallenge.findUniqueOrThrow({
        where: { id: value.challengeId },
      }),
    ).toEqual(before);
    expect(
      await prismaA.authenticationChallengeDelivery.count({
        where: { challengeId: value.challengeId },
      }),
    ).toBe(0);
  });

  it('rolls all GCRA and cooldown writes back when the outer caller fails after allowance', async () => {
    const value = input();
    await expect(
      prismaA.$transaction(async (tx) => {
        expect((await serviceA.admitInTransaction(tx, value)).allowed).toBe(
          true,
        );
        throw new Error('Injected outer admission failure.');
      }),
    ).rejects.toThrow('Injected outer admission failure.');
    expect(await snapshot(value)).toEqual({ cd: [], gcra: [] });
  });

  it('shares the one-operation transaction guard with GCRA admission', async () => {
    const value = input();
    const gcra = new GcraAdmissionService(
      prismaA,
      new RateLimitBucketKeyService(configA),
      gcraRepository,
      new GcraAdmissionConfigService(
        new ConfigService({
          RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
          RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 10,
          RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 10,
        }),
      ),
    );
    await expect(
      prismaA.$transaction(async (tx) => {
        await serviceA.admitInTransaction(tx, value);
        await gcra.consumeManyInTransaction(tx, [
          {
            policy: policies.deliveryIdentity,
            settings: new AuthenticationRateLimitConfigService(configA)
              .deliveryIdentity,
            characteristic: value.normalizedIdentity,
          },
        ]);
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(await snapshot(value)).toEqual({ cd: [], gcra: [] });
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('samples DB time after waiting for a cooldown row lock in the second table', async () => {
    const value = input();
    const alias = keys(value).identity[0];
    await seedCooldown([alias], (await now()) + 3_600_000_000n);
    const ready = deferred<Prisma.TransactionClient>();
    const release = deferred<void>();
    const holding = prismaA.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT 1 FROM "AuthenticationRateLimit" WHERE "key" = ${alias} FOR UPDATE`;
        ready.resolve(tx);
        await release.promise;
      },
      { timeout: 10_000 },
    );
    const control = await ready.promise;
    const pending = admit(value, true);
    try {
      let blocked = false;
      for (let index = 0; index < 300; index++) {
        const rows = await prismaA.$queryRaw<
          { pid: number }[]
        >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaBName} AND wait_event_type='Lock' AND state='active'`;
        if (rows.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      const boundary = await now(control);
      await cooldownRepository.writeAliases(control, [alias], boundary);
      release.resolve();
      await holding;
      const result = await pending;
      expect(result.allowed).toBe(true);
      expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('allows whole-owner retry after a real cooldown-write abort and commits only one admission', async () => {
    const value = input();
    const failingKey = keys(value).identity.sort()[1];
    const schema = `cooldown_retry_${randomUUID().replaceAll('-', '')}`;
    const trigger = `${schema}_trigger`;
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(failingKey))
      throw new Error('Unexpected test key.');
    await prismaA.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prismaA.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
      await prismaA.$executeRawUnsafe(`CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$
        BEGIN IF NEW."key" = TG_ARGV[0] AND nextval('"${schema}".attempts') <= 2 THEN RAISE EXCEPTION 'Injected cooldown abort.' USING ERRCODE='40001'; END IF; RETURN NEW; END $test$`);
      await prismaA.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "AuthenticationRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${failingKey}')`,
      );
      let attempts = 0;
      let result: Awaited<ReturnType<typeof admit>> | undefined;
      while (attempts < 3) {
        attempts++;
        try {
          result = await admit(value);
          break;
        } catch (error) {
          if (!isRetryableGcraTransactionError(error) || attempts === 3)
            throw error;
        }
      }
      expect(attempts).toBe(3);
      expect(result?.allowed).toBe(true);
      const [counter] = await prismaA.$queryRawUnsafe<{ last_value: bigint }[]>(
        `SELECT last_value FROM "${schema}".attempts`,
      );
      expect(counter.last_value).toBe(3n);
      if (!result) throw new Error('Admission result missing.');
      const state = await snapshot(value);
      expect(state.cd).toHaveLength(4);
      expect(state.gcra).toHaveLength(4);
      const pc = new AuthenticationRateLimitConfigService(configA);
      for (const row of state.gcra)
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(
            null,
            row.policyId === policies.deliveryIdentity.id
              ? pc.deliveryIdentity
              : pc.deliveryIp,
            result.operationNowMicros,
          ),
        );
      const cd = await prismaA.$transaction((tx) =>
        cooldownRepository.readAliases(tx, [
          ...keys(value).challenge,
          ...keys(value).identity,
        ]),
      );
      cd.forEach((row) =>
        expect(row.windowEndAtMicros).toBe(
          (result.operationNowMicros + 60_000_000n).toString(),
        ),
      );
    } finally {
      await prismaA.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationRateLimit"`,
      );
      await prismaA.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('rolls back partial writes to both tables even when the caller catches a later cooldown error', async () => {
    const value = input();
    const failingKey = keys(value).identity.sort()[1];
    const schema = `cooldown_fault_${randomUUID().replaceAll('-', '')}`;
    const trigger = `${schema}_trigger`;
    const markerKey = `cooldown-marker-${randomUUID()}`;
    ownedKeys.add(markerKey);
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(failingKey))
      throw new Error('Unexpected test key.');
    await prismaA.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prismaA.$executeRawUnsafe(`CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$
        BEGIN IF NEW."key" = TG_ARGV[0] THEN RAISE EXCEPTION 'Injected cooldown failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`);
      await prismaA.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "AuthenticationRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${failingKey}')`,
      );
      await prismaA.$transaction(async (tx) => {
        await tx.authenticationRateLimit.create({
          data: { key: markerKey, count: 1, windowEndAt: new Date(0) },
        });
        await expect(
          serviceA.admitInTransaction(tx, value),
        ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
      });
      expect(await snapshot(value)).toEqual({ cd: [], gcra: [] });
      expect(
        await prismaA.authenticationRateLimit.findUnique({
          where: { key: markerKey },
        }),
      ).not.toBeNull();
    } finally {
      await prismaA.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationRateLimit"`,
      );
      await prismaA.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
