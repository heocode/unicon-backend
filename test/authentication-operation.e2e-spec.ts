import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Prisma } from '../src/generated/prisma/client';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import {
  chargeGcra,
  createGcraState,
} from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationOperationService } from '../src/auth/operations/services/authentication-operation.service';
import { AuthenticationOperationTelemetryService } from '../src/auth/operations/services/authentication-operation-telemetry.service';
import { AuthenticationOperationRepository } from '../src/auth/operations/repositories/authentication-operation.repository';
import {
  createAuthenticationOperationId,
  authenticationOperationWindow,
} from '../src/auth/operations/utils/authentication-operation-id.util';
import { captureAuthenticationOperation } from '../src/auth/operations/utils/authentication-operation-request.util';
import type { AuthenticationOperationRequest } from '../src/auth/operations/types/authentication-operation.type';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';

describe('Authentication operation receipts (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const operationIds = new Set<string>(),
    identities = new Set<string>(),
    ownedKeys = new Set<string>();
  const replicaName = `operation_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let module: TestingModule;
  let prisma: PrismaService, replica: PrismaService;
  let service: AuthenticationOperationService,
    replicaService: AuthenticationOperationService;
  let repository: AuthenticationOperationRepository;
  let requests: AuthenticationChallengeRequestService;
  let deliveries: AuthenticationDeliveryAdmissionService;
  let bounds: GcraAdmissionConfigService;
  let derivation: RateLimitBucketKeyService;
  let cooldown: AuthenticationDeliveryCooldownRepository;
  let rateConfig: AuthenticationRateLimitConfigService;
  let request: AuthenticationOperationRequest & { kind: 'SIGN_IN_REQUEST' };
  let id: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Operation tests require a dedicated test database.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    repository = module.get(AuthenticationOperationRepository);
    requests = module.get(AuthenticationChallengeRequestService);
    deliveries = module.get(AuthenticationDeliveryAdmissionService);
    bounds = module.get(GcraAdmissionConfigService);
    service = module.get(AuthenticationOperationService);
    replicaService = owner(replica);
    derivation = module.get(RateLimitBucketKeyService);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
    rateConfig = module.get(AuthenticationRateLimitConfigService);
  });

  function owner(client: PrismaService) {
    return new AuthenticationOperationService(
      client,
      repository,
      requests,
      deliveries,
      bounds,
      module.get(AuthenticationOperationTelemetryService),
    );
  }
  async function mint() {
    const value = await service.createOperationId();
    operationIds.add(value);
    return value;
  }
  function newRequest(): AuthenticationOperationRequest & {
    kind: 'SIGN_IN_REQUEST';
  } {
    const identity = `operation-${randomUUID()}@example.edu`;
    identities.add(identity);
    return {
      kind: 'SIGN_IN_REQUEST',
      input: {
        normalizedIdentity: identity,
        ipAddress: `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
        templateProtocolVersion: 1,
      },
    };
  }
  beforeEach(async () => {
    request = newRequest();
    id = await mint();
  });
  afterEach(async () => {
    await snapshot();
    await prisma.authenticationOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.authenticationChallenge.deleteMany({
      where: { normalizedIdentity: { in: [...identities] } },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { normalizedIdentity: { in: [...identities] } },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    operationIds.clear();
    identities.clear();
    ownedKeys.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function keys(challengeId?: string, value = request) {
    const result = {
      identity: derivation
        .deriveKeys(
          policies.identityDeliveryCooldown,
          value.input.normalizedIdentity,
        )
        .buckets.map((b) => b.key),
      emailGcra: derivation
        .deriveKeys(policies.deliveryIdentity, value.input.normalizedIdentity)
        .buckets.map((b) => b.key),
      ipGcra: derivation
        .deriveKeys(policies.deliveryIp, value.input.ipAddress)
        .buckets.map((b) => b.key),
      challenge: challengeId
        ? derivation
            .deriveKeys(policies.challengeDeliveryCooldown, challengeId)
            .buckets.map((b) => b.key)
        : [],
    };
    Object.values(result)
      .flat()
      .forEach((key) => ownedKeys.add(key));
    return result;
  }
  async function snapshot() {
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: { in: [...identities] } },
      orderBy: { id: 'asc' },
    });
    for (const challenge of challenges) {
      const value = {
        kind: 'SIGN_IN_REQUEST' as const,
        input: {
          ...request.input,
          normalizedIdentity: challenge.normalizedIdentity,
        },
      };
      keys(challenge.id, value);
    }
    keys();
    return {
      challenges,
      subjects: await prisma.authenticationChallengeSubject.findMany({
        where: { normalizedIdentity: { in: [...identities] } },
        orderBy: { key: 'asc' },
      }),
      deliveries: await prisma.authenticationChallengeDelivery.findMany({
        where: {
          challengeId: { in: challenges.map((challenge) => challenge.id) },
        },
        orderBy: { id: 'asc' },
      }),
      receipts: await prisma.authenticationOperation.findMany({
        where: { id: { in: [...operationIds] } },
        orderBy: { id: 'asc' },
      }),
      cd: await prisma.$queryRaw<
        { key: string; boundary: string; updated: string }[]
      >(Prisma.sql`
        SELECT "key", "windowEndAt"::text AS boundary,"updatedAt"::text AS updated FROM "AuthenticationRateLimit"
        WHERE "key" IN (${Prisma.join([...ownedKeys])}) ORDER BY "key"`),
      gcra: await prisma.gcraRateLimit.findMany({
        where: { key: { in: [...ownedKeys] } },
        orderBy: { key: 'asc' },
      }),
    };
  }

  async function seedReceipt(
    operationId: string,
    tx?: Prisma.TransactionClient,
  ) {
    operationIds.add(operationId);
    const window = authenticationOperationWindow(operationId);
    const data = {
      id: operationId,
      kind: 'SIGN_IN_REQUEST' as const,
      requestHash: Uint8Array.from(
        captureAuthenticationOperation(operationId, request).requestHash,
      ),
      issuedAt: new Date(Number(window.issuedAtMicros / 1000n)),
      expiresAt: new Date(Number(window.expiresAtMicros / 1000n)),
      retentionExpiresAt: new Date(
        Number(window.retentionExpiresAtMicros / 1000n),
      ),
      outcome: 'DENIED' as const,
      denial: 'CHALLENGE_UNAVAILABLE' as const,
      evaluatedAtMicros: window.issuedAtMicros + 1000n,
    };
    return (tx ?? prisma).authenticationOperation.create({ data });
  }

  it('commits receipt with all effects and replays an immutable minimal result', async () => {
    const first = await service.execute(id, request);
    expect(first.replayed).toBe(false);
    expect(first.result.outcome).toBe('CREATED');
    const before = await snapshot();
    expect(before.receipts).toHaveLength(1);
    expect(before.challenges).toHaveLength(1);
    expect(before.deliveries).toHaveLength(1);
    expect(before.receipts[0].requestHash).toHaveLength(32);
    expect(before.deliveries[0].idempotencyKey).not.toBe(id);
    expect(await replicaService.execute(id, request)).toEqual({
      ...first,
      replayed: true,
    });
    expect(await snapshot()).toEqual(before);
    expect(Object.keys(first.result)).not.toContain('idempotencyKey');
    expect(Object.keys(before.receipts[0])).not.toContain('normalizedIdentity');
  });

  it('serializes many concurrent copies of one operation across clients into one receipt/Delivery/charge', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        (index % 2 ? replicaService : service).execute(id, request),
      ),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    for (const result of results)
      expect(result.result).toEqual(results[0].result);
    const after = await snapshot();
    expect(after.receipts).toHaveLength(1);
    expect(after.deliveries).toHaveLength(1);
    expect(after.challenges).toHaveLength(1);
    if (results[0].result.outcome !== 'CREATED')
      throw new Error('Expected creation.');
    const at = results[0].result.admissionNowMicros;
    for (const row of after.gcra)
      expect(fromGcraPersistenceData(row)).toEqual(
        chargeGcra(
          null,
          row.policyId === policies.deliveryIdentity.id
            ? rateConfig.deliveryIdentity
            : rateConfig.deliveryIp,
          at,
        ),
      );
  });

  it.each(['identity', 'ip', 'template', 'kind'] as const)(
    'rejects reusing the ID with changed %s without overwriting receipt or effects',
    async (field) => {
      const created = await service.execute(id, request);
      if (created.result.outcome !== 'CREATED')
        throw new Error('Expected creation.');
      let changed: AuthenticationOperationRequest;
      if (field === 'kind')
        changed = {
          kind: 'RESEND',
          input: {
            challengeId: created.result.challengeId,
            ipAddress: request.input.ipAddress,
            templateProtocolVersion: 1,
            retentionExpiresAt: new Date(Date.now() + 86_400_000),
          },
        };
      else
        changed = {
          kind: 'SIGN_IN_REQUEST',
          input: {
            ...request.input,
            ...(field === 'identity'
              ? { normalizedIdentity: 'other@example.edu' }
              : field === 'ip'
                ? { ipAddress: '192.0.2.2' }
                : { templateProtocolVersion: 2 }),
          },
        };
      const before = await snapshot();
      await expect(replicaService.execute(id, changed)).rejects.toMatchObject({
        reason: 'OPERATION_CONFLICT',
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it('replays a terminal RESEND rather than admitting another Delivery', async () => {
    const initial = await service.execute(id, request);
    if (initial.result.outcome !== 'CREATED')
      throw new Error('Expected creation.');
    await prisma.authenticationChallengeDelivery.update({
      where: { id: initial.result.deliveryId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: initial.result.challengeId },
    });
    const aliases = keys(challenge.id),
      now = await repository.nowMicros();
    await prisma.$transaction(async (tx) => {
      await cooldown.writeAliases(
        tx,
        [...aliases.identity, ...aliases.challenge],
        now - 1n,
      );
    });
    const resend: AuthenticationOperationRequest = {
      kind: 'RESEND',
      input: {
        challengeId: challenge.id,
        ipAddress: request.input.ipAddress,
        templateProtocolVersion: 1,
        retentionExpiresAt: challenge.retentionExpiresAt,
      },
    };
    const resendId = await mint(),
      first = await service.execute(resendId, resend);
    if (first.result.outcome !== 'CREATED')
      throw new Error('Expected resend creation.');
    await prisma.authenticationChallengeDelivery.update({
      where: { id: first.result.deliveryId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    const before = await snapshot();
    expect(await replicaService.execute(resendId, resend)).toEqual({
      ...first,
      replayed: true,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves the receipt when domain retention removes its challenge and Delivery', async () => {
    const first = await service.execute(id, request);
    if (first.result.outcome !== 'CREATED')
      throw new Error('Expected creation.');
    await prisma.authenticationChallenge.delete({
      where: { id: first.result.challengeId },
    });
    expect(await service.execute(id, request)).toEqual({
      ...first,
      replayed: true,
    });
    expect((await snapshot()).receipts).toHaveLength(1);
    expect((await snapshot()).challenges).toHaveLength(0);
  });

  it('records REUSED and EXISTING outcomes without charging another Delivery', async () => {
    const created = await service.execute(id, request);
    if (created.result.outcome !== 'CREATED')
      throw new Error('Expected creation.');
    const before = await snapshot();
    const reusedId = await mint();
    const reused = await service.execute(reusedId, request);
    expect(reused.result.outcome).toBe('REUSED');
    expect((await service.execute(reusedId, request)).result).toEqual(
      reused.result,
    );
    const challenge = before.challenges[0];
    const resend: AuthenticationOperationRequest = {
      kind: 'RESEND',
      input: {
        challengeId: challenge.id,
        ipAddress: request.input.ipAddress,
        templateProtocolVersion: 1,
        retentionExpiresAt: challenge.retentionExpiresAt,
      },
    };
    const existingId = await mint();
    const existing = await service.execute(existingId, resend);
    expect(existing.result.outcome).toBe('EXISTING');
    expect((await service.execute(existingId, resend)).result).toEqual(
      existing.result,
    );
    const after = await snapshot();
    expect(after.receipts).toHaveLength(3);
    expect(after.cd).toEqual(before.cd);
    expect(after.gcra).toEqual(before.gcra);
    expect(after.deliveries).toEqual(before.deliveries);
  });

  it('stores an absolute denial boundary and does not turn its replay into success after waiting', async () => {
    await prisma.$transaction((tx) =>
      cooldown.writeAliases(
        tx,
        keys().identity,
        BigInt(Date.now()) * 1000n + 500_000n,
      ),
    );
    const first = await service.execute(id, request);
    expect(first.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'RATE_LIMITED',
      remainingWaitSeconds: 1n,
    });
    const before = await snapshot();
    expect(before.challenges).toHaveLength(0);
    expect(before.deliveries).toHaveLength(0);
    expect(before.receipts).toHaveLength(1);
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(0.55)`;
    const replay = await service.execute(id, request);
    expect(replay.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'RATE_LIMITED',
      remainingWaitSeconds: 0n,
    });
    expect(await snapshot()).toEqual(before);
    expect((await service.execute(await mint(), request)).result.outcome).toBe(
      'CREATED',
    );
  });

  it('read-only reconciliation proves absence without running admission', async () => {
    expect(await service.reconcile(id, request)).toEqual({
      status: 'NOT_COMMITTED',
    });
    const after = await snapshot();
    expect(after.receipts).toHaveLength(0);
    expect(after.challenges).toHaveLength(0);
    expect(after.subjects).toHaveLength(0);
  });

  it('persists and replays exact GCRA denial boundaries beyond signed 64-bit time without truncation', async () => {
    const tat = 10n ** 30n;
    await prisma.$transaction((tx) =>
      module
        .get(GcraAdmissionRepository)
        .writeAliases(
          tx,
          keys().emailGcra,
          policies.deliveryIdentity.id,
          createGcraState(
            { numerator: tat, denominator: 1n },
            rateConfig.deliveryIdentity,
          ),
        ),
    );
    const response = await service.execute(id, request);
    if (
      response.result.outcome !== 'DENIED' ||
      response.result.retryNotBeforeMicros === null
    )
      throw new Error('Expected denial.');
    expect(response.result.retryNotBeforeMicros).toBeGreaterThan(
      9_223_372_036_854_775_807n,
    );
    const receipt = await prisma.authenticationOperation.findUniqueOrThrow({
      where: { id },
    });
    expect(receipt.retryNotBeforeMicros?.toFixed(0)).toBe(
      response.result.retryNotBeforeMicros.toString(),
    );
    const replay = await service.execute(id, request);
    expect(replay.result).toMatchObject({
      outcome: 'DENIED',
      retryNotBeforeMicros: response.result.retryNotBeforeMicros,
    });
    expect((await snapshot()).challenges).toHaveLength(0);
  });

  // The transport wrapper delegates real transactions/commits; only acknowledgement
  // delivery is simulated. No database-backed domain service is replaced.
  function transport(
    wrap: (
      callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options: object,
    ) => Promise<unknown>,
  ) {
    return owner({ $transaction: wrap } as unknown as PrismaService);
  }
  function realTransaction(
    callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options: object,
  ) {
    return prisma.$transaction(callback, options);
  }

  it('recovers a real committed operation after a simulated lost acknowledgement', async () => {
    let calls = 0;
    const affected = transport(async (callback, options) => {
      calls++;
      const value = await realTransaction(callback, options);
      if (calls === 1) throw new Error('Simulated lost acknowledgement.');
      return value;
    });
    expect((await affected.execute(id, request)).replayed).toBe(true);
    const after = await snapshot();
    expect(after.receipts).toHaveLength(1);
    expect(after.deliveries).toHaveLength(1);
    expect(after.challenges).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('reports unknown outcome during failed reconciliation and later resolves it without refunds or duplicate writes', async () => {
    let calls = 0;
    const affected = transport(async (callback, options) => {
      calls++;
      if (calls > 1)
        throw new Error('Simulated unavailable reconciliation transport.');
      await realTransaction(callback, options);
      throw new Error('Simulated lost acknowledgement.');
    });
    await expect(affected.execute(id, request)).rejects.toMatchObject({
      reason: 'COMMIT_OUTCOME_UNKNOWN',
    });
    const before = await snapshot();
    expect(before.receipts).toHaveLength(1);
    expect(before.deliveries).toHaveLength(1);
    expect(await service.reconcile(id, request)).toMatchObject({
      status: 'COMMITTED',
    });
    expect((await service.execute(id, request)).replayed).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it('proves NOT_COMMITTED after a real rollback with simulated ambiguous acknowledgement, without automatic replay', async () => {
    let calls = 0;
    const affected = transport(async (callback, options) => {
      calls++;
      if (calls === 1)
        return realTransaction(async (tx) => {
          await callback(tx);
          throw new Error(
            'Simulated rollback with ambiguous transport status.',
          );
        }, options);
      return realTransaction(callback, options);
    });
    await expect(affected.execute(id, request)).rejects.toMatchObject({
      reason: 'NOT_COMMITTED',
    });
    expect(calls).toBe(2);
    const after = await snapshot();
    expect(after.receipts).toHaveLength(0);
    expect(after.challenges).toHaveLength(0);
    expect(after.cd).toHaveLength(0);
    expect(after.gcra).toHaveLength(0);
    expect((await service.execute(id, request)).result.outcome).toBe('CREATED');
  });

  async function waitForReplicaLock() {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Replica did not wait for operation lock.');
  }

  it.each([true, false])(
    'reconciliation waits for the in-flight operation before concluding commit=%s',
    async (commit) => {
      let ready!: (tx: Prisma.TransactionClient) => void, release!: () => void;
      const readyPromise = new Promise<Prisma.TransactionClient>((resolve) => {
        ready = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = prisma.$transaction(
        async (tx) => {
          await repository.lock(tx, id);
          ready(tx);
          await releasePromise;
        },
        { timeout: 10_000 },
      );
      const control = await readyPromise;
      const pending = replicaService.reconcile(id, request);
      try {
        await waitForReplicaLock();
        if (commit) await seedReceipt(id, control);
        release();
        await holding;
        expect(await pending).toMatchObject({
          status: commit ? 'COMMITTED' : 'NOT_COMMITTED',
        });
      } finally {
        release();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  async function withReceiptFailure(
    code: '40001' | '23514',
    failures: number,
    run: () => Promise<void>,
  ) {
    const schema = `receipt_fault_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Unexpected test ID.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."id"::text=TG_ARGV[0] AND nextval('"${schema}".attempts')<=${failures} THEN RAISE EXCEPTION 'Injected receipt failure.' USING ERRCODE='${code}'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuthenticationOperation" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${id}')`,
      );
      await run();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationOperation"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }

  it('retries real confirmed receipt aborts as a whole transaction and commits one charge', async () => {
    await withReceiptFailure('40001', 2, async () => {
      const result = await service.execute(id, request);
      if (result.result.outcome !== 'CREATED')
        throw new Error('Expected creation.');
      const after = await snapshot();
      expect(after.challenges).toHaveLength(1);
      expect(after.deliveries).toHaveLength(1);
      expect(after.receipts).toHaveLength(1);
      for (const row of after.gcra)
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(
            null,
            row.policyId === policies.deliveryIdentity.id
              ? rateConfig.deliveryIdentity
              : rateConfig.deliveryIp,
            result.result.admissionNowMicros,
          ),
        );
    });
  });

  it.each(['40001', '23514'] as const)(
    'rolls back receipt and all domain/rate writes on exhausted/nonretryable %s',
    async (code) => {
      await withReceiptFailure(code, 10, async () => {
        await expect(service.execute(id, request)).rejects.toMatchObject({
          reason: code === '40001' ? 'RETRY_EXHAUSTED' : 'STATE_UNAVAILABLE',
        });
        const after = await snapshot();
        expect(after.challenges).toHaveLength(0);
        expect(after.receipts).toHaveLength(0);
        expect(after.cd).toHaveLength(0);
        expect(after.gcra).toHaveLength(0);
      });
    },
  );

  it('rejects old IDs independently of receipt retention, before and after cleanup', async () => {
    const old = createAuthenticationOperationId(
      (await repository.nowMicros()) - 86_701_000_000n,
    );
    await seedReceipt(old);
    await expect(service.execute(old, request)).rejects.toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    expect(await repository.deleteRetainedBatch(100)).toBe(1);
    await expect(service.execute(old, request)).rejects.toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    expect((await snapshot()).challenges).toHaveLength(0);
  });

  it('cleans only expired-plus-grace receipts in bounded batches without touching domain or rate state', async () => {
    await service.execute(id, request);
    const before = await snapshot();
    const now = await repository.nowMicros();
    for (let i = 0; i < 3; i++)
      await seedReceipt(createAuthenticationOperationId(now - 86_701_000_000n));
    const grace = createAuthenticationOperationId(now - 86_500_000_000n);
    await seedReceipt(grace);
    expect(await repository.deleteRetainedBatch(2)).toBe(2);
    expect(await repository.deleteRetainedBatch(2)).toBe(1);
    const after = await snapshot();
    expect(after.receipts).toHaveLength(2);
    expect(after.receipts.some((receipt) => receipt.id === grace)).toBe(true);
    expect(after.cd).toEqual(before.cd);
    expect(after.gcra).toEqual(before.gcra);
    expect(after.challenges).toEqual(before.challenges);
    expect(after.deliveries).toEqual(before.deliveries);
  });

  it('cleanup skips a locked expired receipt and can remove it after lock release', async () => {
    const now = await repository.nowMicros();
    const old = createAuthenticationOperationId(now - 86_701_000_000n);
    await seedReceipt(old);
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await repository.read(tx, old);
        ready();
        await releasePromise;
      },
      { timeout: 10_000 },
    );
    await readyPromise;
    try {
      expect(await repository.deleteRetainedBatch(1)).toBe(0);
    } finally {
      release();
      await holding;
    }
    expect(await repository.deleteRetainedBatch(1)).toBe(1);
  });

  it('checks ID expiry again after a real operation-lock wait', async () => {
    const nearExpiry = createAuthenticationOperationId(
      (await repository.nowMicros()) - 86_399_000_000n,
    );
    operationIds.add(nearExpiry);
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await repository.lock(tx, nearExpiry);
        ready();
        await releasePromise;
      },
      { timeout: 10_000 },
    );
    await readyPromise;
    const pending = replicaService.execute(nearExpiry, request);
    const checked = expect(pending).rejects.toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    try {
      await waitForReplicaLock();
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
      release();
      await holding;
      await checked;
      expect((await snapshot()).challenges).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('rolls back all new domain/rate writes when the ID expires during a downstream bucket wait', async () => {
    const nearExpiry = createAuthenticationOperationId(
      (await repository.nowMicros()) - 86_399_000_000n,
    );
    operationIds.add(nearExpiry);
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await module
          .get(GcraAdmissionRepository)
          .lockAliases(tx, keys().identity);
        ready();
        await releasePromise;
      },
      { timeout: 10_000 },
    );
    await readyPromise;
    const pending = replicaService.execute(nearExpiry, request);
    const checked = expect(pending).rejects.toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    try {
      await waitForReplicaLock();
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
      release();
      await holding;
      await checked;
      const after = await snapshot();
      expect(after.receipts).toHaveLength(0);
      expect(after.challenges).toHaveLength(0);
      expect(after.deliveries).toHaveLength(0);
      expect(after.cd).toHaveLength(0);
      expect(after.gcra).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled([holding, pending]);
    }
  });
});
