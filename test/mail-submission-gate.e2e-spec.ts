import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import type { Prisma } from '../src/generated/prisma/client';

import { validateEnvironment } from '../src/config/environment.validation';
import { MailModule } from '../src/mail/mail.module';
import { MailProviderPressureRepository } from '../src/mail/repositories/mail-provider-pressure.repository';
import { MAIL_SUBMISSION_GATE as gate } from '../src/mail/constants/mail-submission-gate.constants';
import { MailSubmissionGateConfigService } from '../src/mail/services/mail-submission-gate-config.service';
import { MailSubmissionGateService } from '../src/mail/services/mail-submission-gate.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
} from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import type { GcraState } from '../src/rate-limit/types/gcra-state.type';

// Real exported MailModule service, independent PostgreSQL clients and SQL faults.
// No provider/send path is called, and no service, repository or clock is mocked.
describe('Mail submission permission gate (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  let service: MailSubmissionGateService, second: MailSubmissionGateService;
  let repository: GcraAdmissionRepository,
    config: MailSubmissionGateConfigService,
    bounds: GcraAdmissionConfigService;
  const replicaName = `mail_gate_rival_${randomUUID().replaceAll('-', '')}`;
  const ownedKeys = new Set<string>([gate.key]);
  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnvironment,
        }),
        MailModule,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Dedicated test database required.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    service = module.get(MailSubmissionGateService);
    repository = module.get(GcraAdmissionRepository);
    config = module.get(MailSubmissionGateConfigService);
    bounds = module.get(GcraAdmissionConfigService);
    second = new MailSubmissionGateService(
      replica,
      repository,
      config,
      bounds,
      module.get(MailProviderPressureRepository),
    );
    expect(config.policy).toEqual({ burst: 1, rate: 8, periodSeconds: 1 });
  });
  beforeEach(async () => {
    await prisma.gcraRateLimit.deleteMany({ where: { key: gate.key } });
  });
  afterEach(async () => {
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    ownedKeys.clear();
    ownedKeys.add(gate.key);
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function snapshot() {
    return prisma.gcraRateLimit.findUnique({ where: { key: gate.key } });
  }
  function transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    client = prisma,
  ) {
    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout','3s',true)`;
        return work(tx);
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
  async function seed(tat: bigint, policy = config.policy) {
    await transaction((tx) =>
      repository.writeAliases(
        tx,
        [gate.key],
        gate.policyId,
        createGcraState({ numerator: tat, denominator: 1n }, policy),
      ),
    );
  }
  async function now() {
    return repository.operationNowMicros(prisma);
  }
  function deferred() {
    let resolve!: () => void, reject!: (e: unknown) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  async function waitForLock() {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected real gate serialization wait.');
  }
  async function waitUntil(boundary: bigint) {
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${boundary.toString()}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
  }

  it.each([false, true])(
    'spaces permissions across clients using actual DB times without an idle burst (historical idle=%s)',
    async (idle) => {
      if (idle) await seed((await now()) - 3_600_000_000n);
      const before = await snapshot();
      let reference: GcraState | null = before
        ? fromGcraPersistenceData(before)
        : null;
      const results = await Promise.all(
        Array.from({ length: 32 }, (_, index) =>
          (index % 2 ? second : service).tryAcquire(),
        ),
      );
      results.sort((left, right) =>
        left.operationNowMicros < right.operationNowMicros
          ? -1
          : left.operationNowMicros > right.operationNowMicros
            ? 1
            : 0,
      );
      let grants = 0,
        lastGrant: bigint | undefined;
      for (const result of results) {
        const evaluation = evaluateGcra(
          reference,
          config.policy,
          result.operationNowMicros,
        );
        expect(result.outcome).toBe(
          evaluation.allowed ? 'GRANTED' : 'DEFERRED',
        );
        if (result.outcome === 'GRANTED') {
          grants++;
          if (lastGrant !== undefined)
            expect(
              result.operationNowMicros - lastGrant,
            ).toBeGreaterThanOrEqual(125_000n);
          lastGrant = result.operationNowMicros;
          reference = chargeGcra(
            reference,
            config.policy,
            result.operationNowMicros,
          );
          expect(result.nextPermissionNotBeforeMicros).toBe(
            result.operationNowMicros + 125_000n,
          );
        } else if (result.outcome === 'DEFERRED') {
          const boundary =
            (evaluation.eligibleAt.numerator +
              evaluation.eligibleAt.denominator -
              1n) /
            evaluation.eligibleAt.denominator;
          expect(result.retryNotBeforeMicros).toBe(boundary);
          expect(boundary).toBeGreaterThan(result.operationNowMicros);
        }
      }
      expect(grants).toBeGreaterThanOrEqual(1);
      expect(fromGcraPersistenceData((await snapshot())!)).toEqual(reference);
      // Further grants during a slow batch are valid replenishment, not a batch of
      // eight permissions accumulated by idle time. Fixed-time burst math is unit-covered.
    },
  );

  it('returns a future boundary immediately without writing or fabricating a provider failure', async () => {
    const boundary = (await now()) + 30_000_000n;
    await seed(boundary);
    const before = await snapshot();
    expect(await second.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: boundary,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('grants after the actual persisted eligibility time with no periodic reset', async () => {
    const boundary = (await now()) + 1_000_000n;
    await seed(boundary);
    const before = await snapshot();
    expect(await second.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: boundary,
    });
    expect(await snapshot()).toEqual(before);
    await waitUntil(boundary);
    const result = await second.tryAcquire();
    expect(result.outcome).toBe('GRANTED');
    expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
    expect(fromGcraPersistenceData((await snapshot())!)).toEqual(
      chargeGcra(
        fromGcraPersistenceData(before!),
        config.policy,
        result.operationNowMicros,
      ),
    );
  });

  it.each(['advisory', 'row'] as const)(
    'samples fresh time after a real %s wait',
    async (kind) => {
      const boundary = (await now()) + 800_000n;
      await seed(boundary);
      const ready = deferred(),
        release = deferred();
      const holding = transaction(async (tx) => {
        if (kind === 'advisory') await repository.lockAliases(tx, [gate.key]);
        else
          await tx.$queryRaw`SELECT "key" FROM "GcraRateLimit" WHERE "key"=${gate.key} FOR UPDATE`;
        ready.resolve();
        await release.promise;
      });
      void holding.catch(ready.reject);
      let pending: ReturnType<typeof service.tryAcquire> | undefined;
      try {
        await ready.promise;
        pending = second.tryAcquire();
        void pending.catch(() => undefined);
        await waitForLock();
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release.resolve();
        await holding;
        const result = await pending;
        expect(result.outcome).toBe('GRANTED');
        expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
        expect(fromGcraPersistenceData((await snapshot())!)).toEqual(
          chargeGcra(null, config.policy, result.operationNowMicros),
        );
      } finally {
        release.resolve();
        await Promise.allSettled(pending ? [holding, pending] : [holding]);
      }
    },
  );

  it('fails closed on an incompatible persisted snapshot without retuning/resetting it', async () => {
    await seed((await now()) + 1_000_000n, {
      burst: 2,
      rate: 8,
      periodSeconds: 1,
    });
    const before = await snapshot();
    await expect(service.tryAcquire()).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(await snapshot()).toEqual(before);
  });

  it('keeps a granted but unused permission spent; no message or provider call is required', async () => {
    const slowConfig = new MailSubmissionGateConfigService(
      new ConfigService({
        MAIL_RESEND_SUBMISSIONS_PER_SECOND: 1,
        MAIL_RESEND_TEAM_REQUESTS_PER_SECOND: 10,
      }),
    );
    const owner = new MailSubmissionGateService(
        prisma,
        repository,
        slowConfig,
        bounds,
        module.get(MailProviderPressureRepository),
      ),
      other = new MailSubmissionGateService(
        replica,
        repository,
        slowConfig,
        bounds,
        module.get(MailProviderPressureRepository),
      );
    const result = await owner.tryAcquire();
    if (result.outcome !== 'GRANTED') throw new Error('Expected permission.');
    const before = await snapshot();
    // The caller discards the grant (e.g. stops before provider submission). There
    // is no refund or transfer operation and no provider acceptance is inferred.
    expect(await other.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: result.nextPermissionNotBeforeMicros,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('reports the ceiling of a fractional interval without losing rational state', async () => {
    const tuned = new MailSubmissionGateConfigService(
      new ConfigService({
        MAIL_RESEND_SUBMISSIONS_PER_SECOND: 3,
        MAIL_RESEND_TEAM_REQUESTS_PER_SECOND: 10,
      }),
    );
    const result = await new MailSubmissionGateService(
      prisma,
      repository,
      tuned,
      bounds,
      module.get(MailProviderPressureRepository),
    ).tryAcquire();
    if (result.outcome !== 'GRANTED') throw new Error('Expected permission.');
    expect(result.nextPermissionNotBeforeMicros).toBe(
      result.operationNowMicros + 333_334n,
    );
    expect(fromGcraPersistenceData((await snapshot())!)).toEqual(
      chargeGcra(null, tuned.policy, result.operationNowMicros),
    );
  });

  it('bounds lock waiting and returns a technical error instead of a permission/defer decision', async () => {
    const bounded = new GcraAdmissionConfigService(
      new ConfigService({
        RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
        RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 1,
        RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 1,
      }),
    );
    const rival = new MailSubmissionGateService(
        replica,
        repository,
        config,
        bounded,
        module.get(MailProviderPressureRepository),
      ),
      ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      await repository.lockAliases(tx, [gate.key]);
      ready.resolve();
      await release.promise;
    });
    void holding.catch(ready.reject);
    try {
      await ready.promise;
      await expect(rival.tryAcquire()).rejects.toMatchObject({
        reason: 'STATE_UNAVAILABLE',
      });
      expect(await snapshot()).toBeNull();
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
    }
  });

  it.each(['23514', '40001', '40P01', 'always_abort'] as const)(
    'handles SQL write fault %s with real rollback and bounded whole-owner retry',
    async (fault) => {
      const schema = `mail_gate_fault_${randomUUID().replaceAll('-', '')}`,
        trigger = `${schema}_trigger`,
        state = fault === 'always_abort' ? '40001' : fault;
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      try {
        await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$ DECLARE attempt bigint; BEGIN IF NEW."key"=TG_ARGV[0] THEN attempt:=nextval('"${schema}".attempts'); IF ${fault === 'always_abort' ? 'true' : 'attempt=1'} THEN RAISE EXCEPTION 'Injected mail gate failure.' USING ERRCODE='${state}'; END IF; END IF; RETURN NEW; END $test$`,
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${gate.key}')`,
        );
        if (fault === '23514' || fault === 'always_abort') {
          await expect(service.tryAcquire()).rejects.toMatchObject({
            reason: fault === '23514' ? 'STATE_UNAVAILABLE' : 'RETRY_EXHAUSTED',
          });
          expect(await snapshot()).toBeNull();
        } else {
          const result = await service.tryAcquire();
          expect(result.outcome).toBe('GRANTED');
          expect(fromGcraPersistenceData((await snapshot())!)).toEqual(
            chargeGcra(null, config.policy, result.operationNowMicros),
          );
        }
        const [attempt] = await prisma.$queryRawUnsafe<
          { last_value: bigint }[]
        >(`SELECT last_value FROM "${schema}".attempts`);
        expect(attempt.last_value).toBe(
          fault === '23514' ? 1n : fault === 'always_abort' ? 3n : 2n,
        );
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
        );
        await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }
    },
  );

  it('preserves unrelated GCRA state and restricts the system key to its exact policy', async () => {
    const neighbor = `rl:v1:k1:${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
    ownedKeys.add(neighbor);
    await transaction((tx) =>
      repository.writeAliases(
        tx,
        [neighbor],
        'TEST_MAIL_GATE_NEIGHBOR',
        chargeGcra(null, config.policy, 1n),
      ),
    );
    const before = await prisma.gcraRateLimit.findUniqueOrThrow({
      where: { key: neighbor },
    });
    await service.tryAcquire();
    expect(
      await prisma.gcraRateLimit.findUniqueOrThrow({
        where: { key: neighbor },
      }),
    ).toEqual(before);
    const gateBefore = await snapshot();
    await expect(
      prisma.gcraRateLimit.update({
        where: { key: gate.key },
        data: { policyId: 'AUTH_DELIVERY_GLOBAL' },
      }),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(gateBefore);
    const state = chargeGcra(null, config.policy, await now());
    for (const key of [
      neighbor,
      'gcra:mail:unrelated:v1',
      'gcra:auth:delivery-admission:v1',
    ])
      await expect(
        transaction((tx) =>
          repository.writeAliases(tx, [key], gate.policyId, state),
        ),
      ).rejects.toThrow();
    expect(
      await prisma.gcraRateLimit.findUniqueOrThrow({
        where: { key: neighbor },
      }),
    ).toEqual(before);
    expect(await snapshot()).toEqual(gateBefore);
  });
});
