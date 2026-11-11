import { ConfigService } from '@nestjs/config';

import { randomUUID } from 'node:crypto';

import { AUTHENTICATION_RATE_LIMIT_POLICIES } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import type { GcraState } from '../src/rate-limit/types/gcra-state.type';
import {
  fromGcraPersistenceData,
  toGcraPersistenceData,
} from '../src/rate-limit/utils/gcra-state-persistence.util';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
  getGcraIdleAfterMicros,
  reconcileGcraStates,
  retuneGcraState,
} from '../src/rate-limit/utils/gcra-state.util';

describe('Exact GCRA state persistence (PostgreSQL)', () => {
  const policy = { burst: 6, rate: 6, periodSeconds: 60 };
  const bucketPolicy =
    AUTHENTICATION_RATE_LIMIT_POLICIES.verificationIdentityShortTerm;
  const ownedKeys: string[] = [];
  let prisma: PrismaService;
  let derivation: RateLimitBucketKeyService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
      throw new Error(
        'GCRA persistence tests require a dedicated test database.',
      );
    }
    const config = new ConfigService({
      DATABASE_URL: databaseUrl,
      RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 2,
      RATE_LIMIT_HMAC_KEYS: new Map([
        [1, Buffer.alloc(32, 4)],
        [2, Buffer.alloc(32, 5)],
      ]),
    });
    config.skipProcessEnv = true;
    prisma = new PrismaService(config);
    derivation = new RateLimitBucketKeyService(config);
    await prisma.$connect();
  });

  afterEach(async () => {
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: ownedKeys } },
    });
    ownedKeys.length = 0;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function keys() {
    const result = derivation
      .deriveKeys(bucketPolicy, `gcra-${randomUUID()}@example.edu`)
      .buckets.map((bucket) => bucket.key);
    ownedKeys.push(...result);
    return result;
  }

  async function databaseNowMicros(): Promise<bigint> {
    const [row] = await prisma.$queryRaw<{ nowMicros: string }[]>`
      SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::text AS "nowMicros"
    `;
    return BigInt(row.nowMicros);
  }

  function exhausted(now: bigint): GcraState {
    let state: GcraState | null = null;
    for (let index = 0; index < policy.burst; index++) {
      state = chargeGcra(state, policy, now);
    }
    return state!;
  }

  it('stores epoch-scale, fractional and very large TAT exactly through real Prisma Decimal fields', async () => {
    const now = await databaseNowMicros();
    for (const tat of [
      { numerator: now * 7n + 3_600_000_000n, denominator: 7n },
      { numerator: 10n ** 90n + 1n, denominator: 7n },
    ]) {
      const [key] = keys();
      const state = createGcraState(tat, {
        burst: 10,
        rate: 7,
        periodSeconds: 3600,
      });
      await prisma.gcraRateLimit.create({
        data: {
          key,
          policyId: bucketPolicy.id,
          ...toGcraPersistenceData(state),
        },
      });
      const row = await prisma.gcraRateLimit.findUniqueOrThrow({
        where: { key },
      });
      expect(fromGcraPersistenceData(row)).toEqual(state);
      expect(row.idleAfterMicros.toFixed(0)).toBe(
        getGcraIdleAfterMicros(state).toString(),
      );
    }
    const columns = await prisma.$queryRaw<
      {
        column_name: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
      }[]
    >`
      SELECT column_name, numeric_precision, numeric_scale FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'GcraRateLimit'
        AND column_name IN ('tatNumerator', 'tatDenominator', 'idleAfterMicros')
    `;
    expect(columns).toHaveLength(3);
    expect(
      columns.every(
        (column) =>
          column.numeric_precision === null && column.numeric_scale === null,
      ),
    ).toBe(true);
  });

  it.each([3n, 10n ** 80n])(
    'uses an exact full-recovery deadline even with denominator %s',
    async (denominator) => {
      const now = await databaseNowMicros();
      const state = createGcraState(
        { numerator: now * denominator + 1n, denominator },
        policy,
      );
      const [key] = keys();
      await prisma.gcraRateLimit.create({
        data: {
          key,
          policyId: bucketPolicy.id,
          ...toGcraPersistenceData(state),
        },
      });
      const early = await prisma.gcraRateLimit.deleteMany({
        where: { key, idleAfterMicros: { lte: now.toString() } },
      });
      expect(early.count).toBe(0);
      const eligible = await prisma.gcraRateLimit.deleteMany({
        where: { key, idleAfterMicros: { lte: (now + 1n).toString() } },
      });
      expect(eligible.count).toBe(1);
    },
  );

  it('retains old alias restrictions when the promoted key has no row, without summing mirrored debt', async () => {
    const now = await databaseNowMicros();
    const [oldKey, newKey] = keys();
    const state = exhausted(now);
    await prisma.gcraRateLimit.create({
      data: {
        key: oldKey,
        policyId: bucketPolicy.id,
        ...toGcraPersistenceData(state),
      },
    });
    const oldRows = await prisma.gcraRateLimit.findMany({
      where: { key: { in: [oldKey, newKey] } },
    });
    const restored = reconcileGcraStates(
      oldRows.map(fromGcraPersistenceData),
      policy,
    );
    expect(restored).toEqual(state);
    expect(evaluateGcra(restored, policy, now)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 10n,
    });
    await prisma.gcraRateLimit.create({
      data: {
        key: newKey,
        policyId: bucketPolicy.id,
        ...toGcraPersistenceData(state),
      },
    });
    const bothRows = await prisma.gcraRateLimit.findMany({
      where: { key: { in: [oldKey, newKey] } },
    });
    expect(
      reconcileGcraStates(bothRows.map(fromGcraPersistenceData), policy),
    ).toEqual(state);
  });

  it('persists explicit tuning without clearing active debt or silently reinterpreting old snapshots', async () => {
    const now = await databaseNowMicros();
    const state = exhausted(now);
    const [key] = keys();
    await prisma.gcraRateLimit.create({
      data: { key, policyId: bucketPolicy.id, ...toGcraPersistenceData(state) },
    });
    const newPolicy = { burst: 10, rate: 60, periodSeconds: 60 };
    const old = fromGcraPersistenceData(
      await prisma.gcraRateLimit.findUniqueOrThrow({ where: { key } }),
    );
    expect(() => evaluateGcra(old, newPolicy, now)).toThrow(
      'GCRA policy snapshot mismatch',
    );
    const tuned = retuneGcraState(old, newPolicy, now);
    await prisma.$transaction(async (transaction) => {
      await transaction.gcraRateLimit.update({
        where: { key },
        data: toGcraPersistenceData(tuned),
      });
    });
    const restored = fromGcraPersistenceData(
      await prisma.gcraRateLimit.findUniqueOrThrow({ where: { key } }),
    );
    expect(restored).toEqual(tuned);
    expect(evaluateGcra(restored, newPolicy, now).retryAfterSeconds).toBe(51n);
  });

  it('rolls back partial alias writes and retains the exact previously committed state', async () => {
    const now = await databaseNowMicros();
    const [oldKey, newKey] = keys();
    const state = chargeGcra(null, policy, now);
    await prisma.gcraRateLimit.create({
      data: {
        key: oldKey,
        policyId: bucketPolicy.id,
        ...toGcraPersistenceData(state),
      },
    });
    const charged = chargeGcra(state, policy, now);
    const failure = new Error('Injected GCRA persistence rollback.');
    await expect(
      prisma.$transaction(async (transaction) => {
        await transaction.gcraRateLimit.update({
          where: { key: oldKey },
          data: toGcraPersistenceData(charged),
        });
        await transaction.gcraRateLimit.create({
          data: {
            key: newKey,
            policyId: bucketPolicy.id,
            ...toGcraPersistenceData(charged),
          },
        });
        throw failure;
      }),
    ).rejects.toThrow(failure);
    expect(
      fromGcraPersistenceData(
        await prisma.gcraRateLimit.findUniqueOrThrow({
          where: { key: oldKey },
        }),
      ),
    ).toEqual(state);
    expect(
      await prisma.gcraRateLimit.findUnique({ where: { key: newKey } }),
    ).toBeNull();
  });

  it.each([
    { numerator: '-1' },
    { numerator: '1.5' },
    { numerator: 'NaN' },
    { numerator: 'Infinity' },
    { numerator: '-Infinity' },
    { denominator: '0' },
    { denominator: '-1' },
    { denominator: '1.5' },
    { denominator: 'NaN' },
    { denominator: 'Infinity' },
    { idle: '0' },
    { idle: '1.5' },
    { idle: 'NaN' },
    { idle: 'Infinity' },
    { burst: '0' },
    { rate: '-1' },
    { period: '0' },
    { burst: '9007199254740992' },
    { rate: '9007199254740992' },
    { period: '9007199254740992' },
    { policyId: 'invalid-policy' },
    { key: 'student@example.edu' },
  ])(
    'rejects invalid persisted state at the PostgreSQL boundary: %j',
    async (patch) => {
      const [key] = keys();
      const data = {
        key,
        policyId: bucketPolicy.id,
        numerator: '7',
        denominator: '7',
        idle: '1',
        burst: '6',
        rate: '6',
        period: '60',
        ...patch,
      };
      await expect(prisma.$executeRaw`
      INSERT INTO "GcraRateLimit" ("key", "policyId", "tatNumerator", "tatDenominator", "idleAfterMicros", "burst", "rate", "periodSeconds", "updatedAt")
      VALUES (${data.key}, ${data.policyId}, ${data.numerator}::numeric, ${data.denominator}::numeric, ${data.idle}::numeric, ${data.burst}::bigint, ${data.rate}::bigint, ${data.period}::bigint, clock_timestamp())
    `).rejects.toMatchObject({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      });
      expect(
        await prisma.gcraRateLimit.findUnique({ where: { key } }),
      ).toBeNull();
    },
  );
});
