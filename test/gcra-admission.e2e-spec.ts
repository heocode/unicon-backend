import { ConfigService } from '@nestjs/config';

import { randomUUID } from 'node:crypto';

import { Prisma } from '../src/generated/prisma/client';

import { PUBLIC_PASSWORDLESS_REQUEST_POLICY as policy } from '../src/http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { HttpRequestRateLimitConfigService } from '../src/http-rate-limit/services/http-request-rate-limit-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import type { GcraAdmissionInput } from '../src/rate-limit/types/gcra-admission.type';
import type { GcraState } from '../src/rate-limit/types/gcra-state.type';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
} from '../src/rate-limit/utils/gcra-state.util';
import {
  fromGcraPersistenceData,
  toGcraPersistenceData,
} from '../src/rate-limit/utils/gcra-state-persistence.util';

// Real database, independent clients, actual services and triggers; no service mocks.
describe('Atomic single-policy GCRA admission (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const ownedKeys = new Set<string>();
  const replicaBName = `gcra_admission_b_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const repository = new GcraAdmissionRepository();
  const slowSettings = { burst: 6, rate: 1, periodSeconds: 3600 };
  let databaseUrl: string;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let serviceA: GcraAdmissionService;
  let serviceB: GcraAdmissionService;

  function config(activeVersion = 2, overrides: Record<string, unknown> = {}) {
    const result = new ConfigService({
      DATABASE_URL: databaseUrl,
      RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: activeVersion,
      RATE_LIMIT_HMAC_KEYS: new Map([
        [2, Buffer.alloc(32, 5)],
        [1, Buffer.alloc(32, 4)],
      ]),
      RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
      RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 10,
      RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 10,
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST: 200,
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE: 600,
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS: 60,
      ...overrides,
    });
    result.skipProcessEnv = true;
    return result;
  }

  function service(client: PrismaService, settings = config()) {
    return new GcraAdmissionService(
      client,
      new RateLimitBucketKeyService(settings),
      repository,
      new GcraAdmissionConfigService(settings),
    );
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || !new URL(url).pathname.endsWith('_test')) {
      throw new Error(
        'GCRA admission tests require a dedicated test database.',
      );
    }
    databaseUrl = url;
    const firstUrl = new URL(url);
    firstUrl.searchParams.set('application_name', 'gcra_admission_a');
    const secondUrl = new URL(url);
    secondUrl.searchParams.set('application_name', replicaBName);
    prismaA = new PrismaService(
      config(1, { DATABASE_URL: firstUrl.toString() }),
    );
    prismaB = new PrismaService(
      config(2, { DATABASE_URL: secondUrl.toString() }),
    );
    await Promise.all([prismaA.$connect(), prismaB.$connect()]);
    serviceA = service(prismaA, config(1));
    serviceB = service(prismaB, config(2));
  });

  afterEach(async () => {
    await prismaA.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    ownedKeys.clear();
  });

  afterAll(async () => {
    await Promise.all([prismaA?.$disconnect(), prismaB?.$disconnect()]);
  });

  function input(settings = slowSettings): GcraAdmissionInput {
    const hex = randomUUID().replaceAll('-', '');
    const characteristic = `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}`;
    const result = { policy, settings, characteristic };
    keys(result);
    return result;
  }

  function keys(value: GcraAdmissionInput): string[] {
    const result = new RateLimitBucketKeyService(config())
      .deriveKeys(value.policy, value.characteristic)
      .buckets.map((bucket) => bucket.key);
    result.forEach((key) => ownedKeys.add(key));
    return result;
  }

  async function dbNow(
    transaction: Prisma.TransactionClient = prismaA,
  ): Promise<bigint> {
    const [row] = await transaction.$queryRaw<
      { nowMicros: string }[]
    >`SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::text AS "nowMicros"`;
    return BigInt(row.nowMicros);
  }

  async function store(key: string, state: GcraState) {
    await prismaA.gcraRateLimit.create({
      data: { key, policyId: policy.id, ...toGcraPersistenceData(state) },
    });
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function waitForBlockedReplica(): Promise<number> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await prismaA.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity
        WHERE application_name = ${replicaBName} AND state = 'active' AND wait_event_type = 'Lock'
      `;
      if (rows.length > 0) return rows[0].pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Replica did not reach the expected PostgreSQL lock wait.');
  }

  it('serializes first admission across independent replicas without overshooting burst', async () => {
    // Long test-only interval isolates burst from replenishment during the wave.
    const value = input();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        (index % 2 ? serviceA : serviceB).consume(value),
      ),
    );
    expect(results.filter((result) => result.allowed)).toHaveLength(6);
    expect(results.filter((result) => !result.allowed)).toHaveLength(34);
    let expected: GcraState | null = null;
    for (const result of results
      .filter((result) => result.allowed)
      .sort((left, right) =>
        left.operationNowMicros < right.operationNowMicros ? -1 : 1,
      )) {
      expected = chargeGcra(
        expected,
        value.settings,
        result.operationNowMicros,
      );
    }
    const rows = await prismaA.gcraRateLimit.findMany({
      where: { key: { in: keys(value) } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(fromGcraPersistenceData(row)).toEqual(expected);
    for (const result of results.filter((item) => !item.allowed)) {
      expect(result).toMatchObject(
        evaluateGcra(expected, value.settings, result.operationNowMicros)
          .allowed
          ? { allowed: true }
          : {
              allowed: false,
              retryAfterSeconds: evaluateGcra(
                expected,
                value.settings,
                result.operationNowMicros,
              ).retryAfterSeconds,
            },
      );
    }
  });

  it('enforces the accepted public request policy against the exact DB-time stream', async () => {
    const value = input(
      new HttpRequestRateLimitConfigService(config()).publicPasswordless,
    );
    const results = await Promise.all(
      Array.from({ length: 230 }, (_, index) =>
        (index % 2 ? serviceA : serviceB).consume(value),
      ),
    );
    let expected: GcraState | null = null;
    for (const result of results.sort((left, right) =>
      left.operationNowMicros < right.operationNowMicros ? -1 : 1,
    )) {
      const evaluation = evaluateGcra(
        expected,
        value.settings,
        result.operationNowMicros,
      );
      expect(result.allowed).toBe(evaluation.allowed);
      if (result.allowed)
        expected = chargeGcra(
          expected,
          value.settings,
          result.operationNowMicros,
        );
      else expect(result.retryAfterSeconds).toBe(evaluation.retryAfterSeconds);
    }
    const rows = await prismaA.gcraRateLimit.findMany({
      where: { key: { in: keys(value) } },
    });
    rows.forEach((row) =>
      expect(fromGcraPersistenceData(row)).toEqual(expected),
    );
  });

  it('keeps independent subjects separate', async () => {
    const first = input({ burst: 1, rate: 1, periodSeconds: 3600 });
    const second = input(first.settings);
    expect((await serviceA.consume(first)).allowed).toBe(true);
    expect((await serviceB.consume(first)).allowed).toBe(false);
    expect((await serviceB.consume(second)).allowed).toBe(true);
  });

  it.each([0, 1])(
    'denies from existing alias %i without creating or mutating any alias',
    async (index) => {
      const value = input({ burst: 1, rate: 1, periodSeconds: 3600 });
      const aliasKeys = keys(value);
      const now = await dbNow();
      await store(
        aliasKeys[index],
        createGcraState(
          { numerator: now + 3_600_000_000n, denominator: 1n },
          value.settings,
        ),
      );
      const before = await prismaA.gcraRateLimit.findMany({
        where: { key: { in: aliasKeys } },
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await serviceB.consume(value);
        expect(result.allowed).toBe(false);
        if (!result.allowed)
          expect(result.retryAfterSeconds).toBe(
            evaluateGcra(
              fromGcraPersistenceData(before[0]),
              value.settings,
              result.operationNowMicros,
            ).retryAfterSeconds,
          );
      }
      expect(
        await prismaA.gcraRateLimit.findMany({
          where: { key: { in: aliasKeys } },
        }),
      ).toEqual(before);
    },
  );

  it.each([false, true])(
    'reconciles latest debt with second alias present=%s and mirrors one charge',
    async (secondAliasPresent) => {
      const value = input();
      const aliasKeys = keys(value);
      const now = await dbNow();
      const interval = 3_600_000_000n;
      await store(
        aliasKeys[0],
        createGcraState(
          { numerator: now + interval * 4n, denominator: 1n },
          value.settings,
        ),
      );
      if (secondAliasPresent) {
        await store(
          aliasKeys[1],
          createGcraState(
            { numerator: now + interval * 3n, denominator: 1n },
            value.settings,
          ),
        );
      }
      expect((await serviceB.consume(value)).allowed).toBe(true);
      const rows = await prismaA.gcraRateLimit.findMany({
        where: { key: { in: aliasKeys } },
      });
      for (const row of rows)
        expect(fromGcraPersistenceData(row).tat).toEqual({
          numerator: now + interval * 5n,
          denominator: 1n,
        });
    },
  );

  it.each(['policyId', 'settings'] as const)(
    'fails closed on incompatible %s without partial writes',
    async (kind) => {
      const value = input();
      const [key] = keys(value);
      await store(
        key,
        createGcraState({ numerator: 0n, denominator: 1n }, value.settings),
      );
      if (kind === 'policyId')
        await prismaA.gcraRateLimit.update({
          where: { key },
          data: { policyId: 'OTHER_POLICY' },
        });
      const before = await prismaA.gcraRateLimit.findUniqueOrThrow({
        where: { key },
      });
      await expect(
        serviceA.consume(
          kind === 'settings'
            ? { ...value, settings: { ...value.settings, burst: 7 } }
            : value,
        ),
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      expect(
        await prismaA.gcraRateLimit.findMany({
          where: { key: { in: keys(value) } },
        }),
      ).toEqual([before]);
    },
  );

  it.each(['advisory', 'row'] as const)(
    'samples fresh DB time after a real %s lock wait',
    async (kind) => {
      const value = input({ burst: 1, rate: 1, periodSeconds: 3600 });
      const aliasKeys = keys(value);
      await store(
        aliasKeys[0],
        createGcraState(
          { numerator: (await dbNow()) + 3_600_000_000n, denominator: 1n },
          value.settings,
        ),
      );
      const ready = deferred<Prisma.TransactionClient>();
      const release = deferred<void>();
      const holding = prismaA.$transaction(
        async (transaction) => {
          if (kind === 'advisory')
            await repository.lockAliases(transaction, aliasKeys);
          else
            await transaction.$executeRaw`SELECT 1 FROM "GcraRateLimit" WHERE "key" = ${aliasKeys[0]} FOR UPDATE`;
          ready.resolve(transaction);
          await release.promise;
        },
        { timeout: 10_000 },
      );
      const transaction = await ready.promise;
      const pending = serviceB.consume(value);
      try {
        await waitForBlockedReplica();
        const boundary = await dbNow(transaction);
        await transaction.gcraRateLimit.update({
          where: { key: aliasKeys[0] },
          data: toGcraPersistenceData(
            createGcraState(
              { numerator: boundary, denominator: 1n },
              value.settings,
            ),
          ),
        });
        release.resolve();
        await holding;
        const result = await pending;
        expect(result.allowed).toBe(true);
        expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
      } finally {
        release.resolve();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  async function withWriteFault(
    key: string,
    sqlState: '23514' | '40001' | '40P01',
    failures: number,
    action: (attemptCount: () => Promise<bigint>) => Promise<void>,
  ) {
    const schema = `gcra_admission_${randomUUID().replaceAll('-', '')}`;
    const trigger = `${schema}_trigger`;
    // All identifiers/arguments are locally generated; the key alphabet excludes quotes.
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
      throw new Error('Unexpected test key format.');
    await prismaA.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prismaA.$executeRawUnsafe(`CREATE SEQUENCE "${schema}"."attempts"`);
      await prismaA.$executeRawUnsafe(`CREATE FUNCTION "${schema}"."fail_alias"() RETURNS trigger LANGUAGE plpgsql AS $test$
        BEGIN
          IF NEW."key" = TG_ARGV[0] AND nextval('"${schema}"."attempts"') <= ${failures} THEN
            RAISE EXCEPTION 'Injected GCRA alias write failure.' USING ERRCODE = '${sqlState}';
          END IF;
          RETURN NEW;
        END $test$`);
      await prismaA.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}"."fail_alias"('${key}')`,
      );
      await action(async () => {
        const [row] = await prismaA.$queryRawUnsafe<{ last_value: bigint }[]>(
          `SELECT last_value FROM "${schema}"."attempts"`,
        );
        return row.last_value;
      });
    } finally {
      await prismaA.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
      );
      await prismaA.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }

  it('rolls back a real first-alias insert when writing the second alias fails', async () => {
    const value = input();
    const aliasKeys = keys(value).sort();
    await withWriteFault(aliasKeys[1], '23514', 5, async (attemptCount) => {
      await expect(serviceA.consume(value)).rejects.toMatchObject({
        reason: 'STATE_UNAVAILABLE',
      });
      expect(await attemptCount()).toBe(1n);
      expect(
        await prismaA.gcraRateLimit.count({
          where: { key: { in: aliasKeys } },
        }),
      ).toBe(0);
    });
  });

  it.each(['40001', '40P01'] as const)(
    'retries DB-confirmed abort %s and commits exactly one charge',
    async (sqlState) => {
      const value = input();
      const aliasKeys = keys(value).sort();
      await withWriteFault(aliasKeys[1], sqlState, 2, async (attemptCount) => {
        const result = await serviceA.consume(value);
        expect(result.allowed).toBe(true);
        expect(await attemptCount()).toBe(3n);
        const expected = chargeGcra(
          null,
          value.settings,
          result.operationNowMicros,
        );
        const rows = await prismaA.gcraRateLimit.findMany({
          where: { key: { in: aliasKeys } },
        });
        expect(rows).toHaveLength(2);
        rows.forEach((row) =>
          expect(fromGcraPersistenceData(row)).toEqual(expected),
        );
      });
    },
  );

  it('bounds confirmed rollback retries and leaves no charge after exhaustion', async () => {
    const value = input();
    const aliasKeys = keys(value).sort();
    await withWriteFault(aliasKeys[1], '40001', 5, async (attemptCount) => {
      await expect(serviceA.consume(value)).rejects.toMatchObject({
        reason: 'RETRY_EXHAUSTED',
      });
      expect(await attemptCount()).toBe(3n);
      expect(
        await prismaA.gcraRateLimit.count({
          where: { key: { in: aliasKeys } },
        }),
      ).toBe(0);
    });
  });

  it('treats a real lock timeout as technical failure without a fabricated denial or charge', async () => {
    const value = input();
    const aliasKeys = keys(value);
    const ready = deferred<void>();
    const release = deferred<void>();
    const holding = prismaA.$transaction(
      async (transaction) => {
        await repository.lockAliases(transaction, aliasKeys);
        ready.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    await ready.promise;
    const impatient = service(
      prismaB,
      config(2, { RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 1 }),
    );
    const pending = impatient.consume(value);
    const failed = expect(pending).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    try {
      await waitForBlockedReplica();
      await failed;
      expect(
        await prismaA.gcraRateLimit.count({
          where: { key: { in: aliasKeys } },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('fails closed on a lost PostgreSQL connection while waiting for admission', async () => {
    const value = input();
    const aliasKeys = keys(value);
    const ready = deferred<void>();
    const release = deferred<void>();
    const holding = prismaA.$transaction(
      async (transaction) => {
        await repository.lockAliases(transaction, aliasKeys);
        ready.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    await ready.promise;
    const pending = serviceB.consume(value);
    // Attach rejection handling before deliberately terminating a backend.
    const failed = expect(pending).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    try {
      const pid = await waitForBlockedReplica();
      await prismaA.$queryRaw`SELECT pg_terminate_backend(${pid})`;
      await failed;
      expect(
        await prismaA.gcraRateLimit.count({
          where: { key: { in: aliasKeys } },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });
});
