import { ConfigService } from '@nestjs/config';

import { randomUUID } from 'node:crypto';

import { Prisma } from '../src/generated/prisma/client';

import { AUTHENTICATION_RATE_LIMIT_POLICIES } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY as policy } from '../src/http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { HttpRequestRateLimitConfigService } from '../src/http-rate-limit/services/http-request-rate-limit-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import type {
  GcraAdmissionInput,
  GcraMultiAdmissionResult,
} from '../src/rate-limit/types/gcra-admission.type';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';
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
describe('Atomic GCRA admission (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const ownedKeys = new Set<string>();
  const ownedMarkers = new Set<string>();
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
    await prismaA.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedMarkers] } },
    });
    ownedMarkers.clear();
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

  async function store(key: string, state: GcraState, policyId = policy.id) {
    await prismaA.gcraRateLimit.create({
      data: { key, policyId, ...toGcraPersistenceData(state) },
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

  function group(
    settings = slowSettings,
  ): [GcraAdmissionInput, GcraAdmissionInput, GcraAdmissionInput] {
    const request = input(settings);
    const identity = {
      ...request,
      policy: AUTHENTICATION_RATE_LIMIT_POLICIES.deliveryIdentity,
      characteristic: `multi-${randomUUID()}@example.edu`,
    };
    const ip = {
      ...request,
      policy: AUTHENTICATION_RATE_LIMIT_POLICIES.deliveryIp,
    };
    [identity, ip].forEach((item) => keys(item));
    return [identity, ip, request];
  }

  function marker() {
    const key = `gcra-outer-${randomUUID()}`;
    ownedMarkers.add(key);
    // Fixture mutation representing the caller's own work, not cooldown logic.
    return { key, count: 1, windowEndAt: new Date(0) };
  }

  async function readGroup(inputs: readonly GcraAdmissionInput[]) {
    return prismaA.gcraRateLimit.findMany({
      where: { key: { in: inputs.flatMap(keys) } },
      orderBy: { key: 'asc' },
    });
  }

  it('charges all policies and aliases using the same authoritative operation time', async () => {
    const [a, b] = group();
    const result = await serviceA.consumeMany([b, a]);
    expect(result.allowed).toBe(true);
    const rows = await readGroup([a, b]);
    expect(rows).toHaveLength(4);
    for (const item of [a, b]) {
      const expected = chargeGcra(
        null,
        item.settings,
        result.operationNowMicros,
      );
      const aliases = rows.filter((row) => row.policyId === item.policy.id);
      expect(aliases).toHaveLength(2);
      aliases.forEach((row) =>
        expect(fromGcraPersistenceData(row)).toEqual(expected),
      );
    }
  });

  it('leaves every policy unchanged when only one denies, including absent allowed buckets', async () => {
    const [a, b] = group({ burst: 1, rate: 1, periodSeconds: 3600 });
    const state = createGcraState(
      { numerator: (await dbNow()) + 3_600_000_000n, denominator: 1n },
      b.settings,
    );
    await store(keys(b)[0], state, b.policy.id);
    const before = await readGroup([a, b]);
    const result = await serviceA.consumeMany([a, b]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.deniedPolicyIds).toEqual([b.policy.id]);
      expect(result.retryAfterSeconds).toBe(
        evaluateGcra(state, b.settings, result.operationNowMicros)
          .retryAfterSeconds,
      );
    }
    expect(await readGroup([a, b])).toEqual(before);
  });

  it('reports overlapping denials and the latest recovery without moving either boundary', async () => {
    const [a, b] = group({ burst: 1, rate: 1, periodSeconds: 3600 });
    const now = await dbNow();
    const stateA = createGcraState(
      { numerator: now + 3_600_000_000n, denominator: 1n },
      a.settings,
    );
    const stateB = createGcraState(
      { numerator: now + 7_200_000_000n, denominator: 1n },
      b.settings,
    );
    await store(keys(a)[0], stateA, a.policy.id);
    await store(keys(b)[0], stateB, b.policy.id);
    const before = await readGroup([a, b]);
    for (const inputs of [
      [b, a],
      [a, b],
    ]) {
      const result = await serviceB.consumeMany(inputs);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.deniedPolicyIds).toEqual([a.policy.id, b.policy.id]);
        expect(result.retryAfterSeconds).toBe(
          evaluateGcra(stateB, b.settings, result.operationNowMicros)
            .retryAfterSeconds,
        );
      }
    }
    expect(await readGroup([a, b])).toEqual(before);
  });

  it('does not hide a later incompatible snapshot behind an earlier policy denial', async () => {
    const [a, b] = group({ burst: 1, rate: 1, periodSeconds: 3600 });
    const tat = {
      numerator: (await dbNow()) + 3_600_000_000n,
      denominator: 1n,
    };
    await store(keys(a)[0], createGcraState(tat, a.settings), a.policy.id);
    await store(
      keys(b)[0],
      createGcraState(tat, { ...b.settings, burst: 2 }),
      b.policy.id,
    );
    const before = await readGroup([a, b]);
    await expect(serviceA.consumeMany([a, b])).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(await readGroup([a, b])).toEqual(before);
  });

  it('serializes overlapping A+B and B+C groups in reverse input orders without partial charge or overshoot', async () => {
    const [a, b, c] = group();
    const calls = Array.from({ length: 40 }, (_, index) => {
      const selected = index % 2 === 0 ? [a, b] : [b, c];
      const inputs = index % 4 < 2 ? selected : [...selected].reverse();
      return { inputs, owner: index % 2 === 0 ? serviceA : serviceB };
    });
    const results = await Promise.all(
      calls.map(async ({ owner, inputs }) => ({
        inputs,
        result: await owner.consumeMany(inputs),
      })),
    );
    expect(results.filter(({ result }) => result.allowed)).toHaveLength(6);
    const expected = new Map<string, GcraState>();
    for (const { inputs, result } of results
      .filter((item) => item.result.allowed)
      .sort((left, right) =>
        left.result.operationNowMicros < right.result.operationNowMicros
          ? -1
          : 1,
      )) {
      for (const item of inputs)
        expected.set(
          item.policy.id,
          chargeGcra(
            expected.get(item.policy.id) ?? null,
            item.settings,
            result.operationNowMicros,
          ),
        );
    }
    const rows = await readGroup([a, b, c]);
    for (const item of [a, b, c]) {
      const aliases = rows.filter((row) => row.policyId === item.policy.id);
      expect(aliases).toHaveLength(expected.has(item.policy.id) ? 2 : 0);
      aliases.forEach((row) =>
        expect(fromGcraPersistenceData(row)).toEqual(
          expected.get(item.policy.id),
        ),
      );
    }
  });

  it('samples time only after the complete multi-policy lock union has been acquired', async () => {
    const [a, b] = group({ burst: 1, rate: 1, periodSeconds: 3600 });
    const aliases = keys(b);
    await store(
      aliases[0],
      createGcraState(
        { numerator: (await dbNow()) + 3_600_000_000n, denominator: 1n },
        b.settings,
      ),
      b.policy.id,
    );
    const ready = deferred<Prisma.TransactionClient>();
    const release = deferred<void>();
    const holding = prismaA.$transaction(
      async (tx) => {
        await repository.lockAliases(tx, aliases);
        ready.resolve(tx);
        await release.promise;
      },
      { timeout: 10_000 },
    );
    const tx = await ready.promise;
    const pending = serviceB.consumeMany([a, b]);
    try {
      await waitForBlockedReplica();
      const boundary = await dbNow(tx);
      await tx.gcraRateLimit.update({
        where: { key: aliases[0] },
        data: toGcraPersistenceData(
          createGcraState({ numerator: boundary, denominator: 1n }, b.settings),
        ),
      });
      release.resolve();
      await holding;
      const result = await pending;
      expect(result.allowed).toBe(true);
      expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
      (await readGroup([a, b])).forEach((row) =>
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(null, a.settings, result.operationNowMicros),
        ),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('requires a fresh outer transaction after a real SERIALIZABLE stale-snapshot conflict', async () => {
    const [a, b] = group({ burst: 1, rate: 1, periodSeconds: 3600 });
    const aliases = keys(b);
    await store(
      aliases[0],
      createGcraState(
        { numerator: (await dbNow()) + 3_600_000_000n, denominator: 1n },
        b.settings,
      ),
      b.policy.id,
    );
    const ready = deferred<Prisma.TransactionClient>();
    const release = deferred<void>();
    const holding = prismaA.$transaction(
      async (tx) => {
        await repository.lockAliases(tx, aliases);
        ready.resolve(tx);
        await release.promise;
      },
      { timeout: 10_000 },
    );
    const control = await ready.promise;
    const pending = prismaB.$transaction(
      async (tx) => {
        // Establish the owner's snapshot before another transaction changes B.
        await tx.gcraRateLimit.findUniqueOrThrow({
          where: { key: aliases[0] },
        });
        return serviceB.consumeManyInTransaction(tx, [a, b]);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10_000,
      },
    );
    const failed = expect(pending).rejects.toMatchObject({
      reason: 'TRANSACTION_ABORTED',
    });
    try {
      await waitForBlockedReplica();
      const boundary = await dbNow(control);
      await control.gcraRateLimit.update({
        where: { key: aliases[0] },
        data: toGcraPersistenceData(
          createGcraState({ numerator: boundary, denominator: 1n }, b.settings),
        ),
      });
      release.resolve();
      await holding;
      await failed;
      expect(await readGroup([a, b])).toHaveLength(1);
      const retried = await prismaB.$transaction(
        (tx) => serviceB.consumeManyInTransaction(tx, [a, b]),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      expect(retried.allowed).toBe(true);
      expect(await readGroup([a, b])).toHaveLength(4);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('does not commit provisional admission or caller mutations before the outer owner commits', async () => {
    const [a, b] = group();
    const callerRow = marker();
    const ready = deferred<GcraMultiAdmissionResult>();
    const release = deferred<void>();
    const pending = prismaA.$transaction(
      async (tx) => {
        const result = await serviceA.consumeManyInTransaction(tx, [a, b]);
        await tx.authenticationRateLimit.create({ data: callerRow });
        ready.resolve(result);
        await release.promise;
        return result;
      },
      { timeout: 10_000 },
    );
    try {
      expect((await ready.promise).allowed).toBe(true);
      expect(await readGroup([a, b])).toHaveLength(0);
      expect(
        await prismaB.authenticationRateLimit.findUnique({
          where: { key: callerRow.key },
        }),
      ).toBeNull();
      release.resolve();
      expect((await pending).allowed).toBe(true);
      expect(await readGroup([a, b])).toHaveLength(4);
      expect(
        await prismaB.authenticationRateLimit.findUnique({
          where: { key: callerRow.key },
        }),
      ).not.toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it('rolls all limiter charges and caller work back when the outer owner fails after admission', async () => {
    const [a, b] = group();
    const callerRow = marker();
    await expect(
      prismaA.$transaction(async (tx) => {
        await tx.authenticationRateLimit.create({ data: callerRow });
        expect(
          (await serviceA.consumeManyInTransaction(tx, [a, b])).allowed,
        ).toBe(true);
        throw new Error('Injected failure after provisional admission.');
      }),
    ).rejects.toThrow('Injected failure after provisional admission.');
    expect(await readGroup([a, b])).toHaveLength(0);
    expect(
      await prismaA.authenticationRateLimit.findUnique({
        where: { key: callerRow.key },
      }),
    ).toBeNull();
  });

  it('rejects a root client, unsupported isolation and repeated composable calls', async () => {
    const [a, b] = group();
    await expect(
      serviceA.consumeManyInTransaction(prismaA, [a, b]),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      prismaA.$transaction(
        (tx) => serviceA.consumeManyInTransaction(tx, [a, b]),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      prismaA.$transaction(async (tx) => {
        await serviceA.consumeManyInTransaction(tx, [a, b]);
        await serviceB.consumeManyInTransaction(tx, [a]);
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(await readGroup([a, b])).toHaveLength(0);
  });

  it('rolls every policy back when a later policy write fails in the owned transaction', async () => {
    const [a, b] = group();
    await withWriteFault(
      keys(b).sort()[1],
      '23514',
      5,
      async (attemptCount) => {
        await expect(serviceA.consumeMany([a, b])).rejects.toMatchObject({
          reason: 'STATE_UNAVAILABLE',
        });
        expect(await attemptCount()).toBe(1n);
        expect(await readGroup([a, b])).toHaveLength(0);
      },
    );
  });

  it('rolls back to the savepoint even when the caller catches a later-policy write error', async () => {
    const [a, b] = group();
    const callerRow = marker();
    await withWriteFault(
      keys(b).sort()[1],
      '23514',
      5,
      async (attemptCount) => {
        await prismaA.$transaction(async (tx) => {
          await tx.authenticationRateLimit.create({ data: callerRow });
          await expect(
            serviceA.consumeManyInTransaction(tx, [a, b]),
          ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
        });
        expect(await attemptCount()).toBe(1n);
        expect(await readGroup([a, b])).toHaveLength(0);
        expect(
          await prismaA.authenticationRateLimit.findUnique({
            where: { key: callerRow.key },
          }),
        ).not.toBeNull();
      },
    );
  });

  it('lets the external owner retry its whole SERIALIZABLE transaction after confirmed aborts', async () => {
    const [a, b] = group();
    const callerRow = marker();
    await withWriteFault(
      keys(b).sort()[1],
      '40001',
      2,
      async (attemptCount) => {
        let attempts = 0;
        let committed: GcraMultiAdmissionResult | undefined;
        while (attempts < 3) {
          attempts++;
          try {
            committed = await prismaA.$transaction(
              async (tx) => {
                await tx.authenticationRateLimit.create({ data: callerRow });
                return serviceA.consumeManyInTransaction(tx, [a, b]);
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
            break;
          } catch (error) {
            if (!isRetryableGcraTransactionError(error) || attempts === 3)
              throw error;
          }
        }
        expect(attempts).toBe(3);
        expect(await attemptCount()).toBe(3n);
        expect(committed?.allowed).toBe(true);
        expect(await readGroup([a, b])).toHaveLength(4);
        expect(
          await prismaA.authenticationRateLimit.count({
            where: { key: callerRow.key },
          }),
        ).toBe(1);
      },
    );
  });

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
