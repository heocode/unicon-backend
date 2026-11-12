import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type AuthenticationChallenge,
} from '../src/generated/prisma/client';

import { AuthModule } from '../src/auth/auth.module';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationDeliveryPolicyService } from '../src/auth/delivery/services/authentication-delivery-policy.service';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationEmailProviderPort } from '../src/auth/delivery/ports/authentication-email-provider.port';
import { AuthenticationDeliveryCancellationReason } from '../src/auth/delivery/types/authentication-delivery.type';
import { AuthenticationOperationService } from '../src/auth/operations/services/authentication-operation.service';
import { AuthenticationOperationRepository } from '../src/auth/operations/repositories/authentication-operation.repository';
import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
} from '../src/auth/operations/types/authentication-operation.type';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../src/auth/rate-limit/constants/authentication-global-delivery-admission.constants';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { validateEnvironment } from '../src/config/environment.validation';
import { HttpRateLimitModule } from '../src/http-rate-limit/http-rate-limit.module';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY } from '../src/http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { HttpRequestRateLimitConfigService } from '../src/http-rate-limit/services/http-request-rate-limit-config.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';

// Real admission/receipts/worker/cleanup and PostgreSQL. Only external email
// submission is replaced; no application service, repository or clock is mocked.
describe('Auth Delivery backlog admission (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  let operations: AuthenticationOperationService,
    replicaOperations: AuthenticationOperationService;
  let requests: AuthenticationChallengeRequestService,
    admission: AuthenticationDeliveryAdmissionService;
  let deliveries: AuthenticationDeliveryRepository,
    worker: AuthenticationDeliveryOrchestrationService;
  let derivation: RateLimitBucketKeyService,
    cooldown: AuthenticationDeliveryCooldownRepository;
  let ip: string;
  const identities = new Set<string>(),
    operationIds = new Set<string>(),
    ownedKeys = new Set<string>(),
    ownerSubjects = new Set<string>();
  const replicaName = `backlog_rival_${randomUUID().replaceAll('-', '')}`;
  const provider = {
    submit: jest.fn().mockResolvedValue({ outcome: 'ACCEPTED' }),
  };
  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: (env) =>
            validateEnvironment({ ...env, AUTH_DELIVERY_BACKLOG_LIMIT: '3' }),
        }),
        AuthModule,
        HttpRateLimitModule,
      ],
    })
      .overrideProvider(AuthenticationEmailProviderPort)
      .useValue(provider)
      .compile();
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
    requests = module.get(AuthenticationChallengeRequestService);
    admission = module.get(AuthenticationDeliveryAdmissionService);
    operations = module.get(AuthenticationOperationService);
    const bounds = module.get(GcraAdmissionConfigService);
    replicaOperations = new AuthenticationOperationService(
      replica,
      new AuthenticationOperationRepository(replica, bounds),
      requests,
      admission,
      bounds,
    );
    deliveries = module.get(AuthenticationDeliveryRepository);
    worker = module.get(AuthenticationDeliveryOrchestrationService);
    derivation = module.get(RateLimitBucketKeyService);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
    expect(module.get(AuthenticationDeliveryPolicyService).backlogLimit).toBe(
      3,
    );
  });
  beforeEach(async () => {
    ip = `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`;
    provider.submit.mockReset().mockResolvedValue({ outcome: 'ACCEPTED' });
    ownedKeys.add(globalAdmission.key);
    expect(await outstanding()).toBe(0);
  });
  afterEach(async () => {
    await prisma.authenticationOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.authenticationChallenge.deleteMany({
      where: { normalizedIdentity: { in: [...identities] } },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: {
        OR: [
          { normalizedIdentity: { in: [...identities] } },
          { key: { in: [...ownerSubjects] } },
        ],
      },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    identities.clear();
    operationIds.clear();
    ownedKeys.clear();
    ownerSubjects.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function input() {
    const normalizedIdentity = `backlog-${randomUUID()}@example.edu`;
    identities.add(normalizedIdentity);
    track(normalizedIdentity);
    return {
      normalizedIdentity,
      ipAddress: ip,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
    };
  }
  function request(value = input()): AuthenticationOperationRequest {
    return {
      kind: 'SIGN_IN_REQUEST',
      input: {
        normalizedIdentity: value.normalizedIdentity,
        ipAddress: ip,
        templateProtocolVersion: 1,
      },
    };
  }
  function resend(
    challenge: AuthenticationChallenge,
  ): AuthenticationOperationRequest {
    return {
      kind: 'RESEND',
      input: {
        challengeId: challenge.id,
        ipAddress: ip,
        templateProtocolVersion: 1,
        retentionExpiresAt: challenge.retentionExpiresAt,
      },
    };
  }
  function track(identity: string, id?: string) {
    const result = {
      identity: derivation
        .deriveKeys(policies.identityDeliveryCooldown, identity)
        .buckets.map((b) => b.key),
      email: derivation
        .deriveKeys(policies.deliveryIdentity, identity)
        .buckets.map((b) => b.key),
      ip: derivation
        .deriveKeys(policies.deliveryIp, ip)
        .buckets.map((b) => b.key),
      request: derivation
        .deriveKeys(PUBLIC_PASSWORDLESS_REQUEST_POLICY, ip)
        .buckets.map((b) => b.key),
      challenge: id
        ? derivation
            .deriveKeys(policies.challengeDeliveryCooldown, id)
            .buckets.map((b) => b.key)
        : [],
    };
    Object.values(result)
      .flat()
      .forEach((key) => ownedKeys.add(key));
    return result;
  }
  async function execute(value = request(), other = false) {
    const owner = other ? replicaOperations : operations,
      id = await owner.createOperationId();
    operationIds.add(id);
    const response = await owner.execute(id, value);
    if (response.result.outcome === 'CREATED') {
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: response.result.challengeId },
      });
      track(challenge.normalizedIdentity, challenge.id);
    }
    return response;
  }
  function created(response: AuthenticationOperationResponse) {
    if (response.result.outcome !== 'CREATED')
      throw new Error('Expected new admission.');
    return response.result;
  }
  async function fill(count = 3) {
    const result: AuthenticationOperationResponse[] = [];
    for (let i = 0; i < count; i++) result.push(await execute());
    return result;
  }
  async function outstanding() {
    return prisma.authenticationChallengeDelivery.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    });
  }
  function coordination() {
    return prisma.$queryRaw<
      { id: number; updated: string; version: string }[]
    >`SELECT "id","updatedAt"::text AS updated,xmin::text AS version FROM "AuthenticationDeliveryBacklogState"`;
  }
  async function state() {
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: { in: [...identities] } },
      orderBy: { id: 'asc' },
    });
    challenges.forEach((challenge) =>
      track(challenge.normalizedIdentity, challenge.id),
    );
    return {
      challenges,
      subjects: await prisma.authenticationChallengeSubject.findMany({
        where: { normalizedIdentity: { in: [...identities] } },
        orderBy: { key: 'asc' },
      }),
      deliveries: await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId: { in: challenges.map((c) => c.id) } },
        orderBy: { id: 'asc' },
      }),
      gcra: await prisma.gcraRateLimit.findMany({
        where: { key: { in: [...ownedKeys] } },
        orderBy: { key: 'asc' },
      }),
      cd: await prisma.$queryRaw<
        { key: string; boundary: string; updated: string }[]
      >(
        Prisma.sql`SELECT "key","windowEndAt"::text AS boundary,"updatedAt"::text AS updated FROM "AuthenticationRateLimit" WHERE "key" IN (${Prisma.join([...ownedKeys])}) ORDER BY "key"`,
      ),
      coordination: await coordination(),
    };
  }
  function transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
    client = prisma,
    isolation: Prisma.TransactionIsolationLevel = 'ReadCommitted',
  ) {
    return client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout','5s',true)`;
        return work(tx);
      },
      { isolationLevel: isolation, timeout: 10_000, maxWait: 5_000 },
    );
  }
  function deferred() {
    let resolve!: () => void, reject!: (error: unknown) => void;
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
    throw new Error('Expected real DB lock wait.');
  }
  async function allowInterval(challenge: AuthenticationChallenge) {
    // Explicit historical interval fixture; no Delivery/GCRA/proof state changes.
    const aliases = track(challenge.normalizedIdentity, challenge.id);
    const [row] = await prisma.$queryRaw<
      { now: string }[]
    >`SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp())*1000000)::text AS now`;
    await transaction((tx) =>
      cooldown.writeAliases(
        tx,
        [...aliases.identity, ...aliases.challenge],
        BigInt(row.now) - 1n,
      ),
    );
  }
  async function markTerminal(kind: 'SENT' | 'FAILED' | 'CANCELLED') {
    const claim = await deliveries.claimNextDelivery();
    if (!claim) throw new Error('Expected worker claim.');
    const result =
      kind === 'SENT'
        ? await deliveries.markSent(claim.id, claim.leaseId, 'test-provider')
        : kind === 'FAILED'
          ? await deliveries.markFailed(claim.id, claim.leaseId, 'TEST_FAILURE')
          : await deliveries.cancelOwnedDelivery(
              claim.id,
              claim.leaseId,
              AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
            );
    expect(result).toBe('APPLIED');
    return claim;
  }

  it('admits only three concurrent INITIALs across clients, with no challenge or partial charges for losing operations', async () => {
    const values = Array.from({ length: 9 }, () => request()),
      responses = await Promise.all(
        values.map((value, i) => execute(value, i % 2 === 1)),
      );
    expect(
      responses.filter((response) => response.result.outcome === 'CREATED'),
    ).toHaveLength(3);
    expect(await outstanding()).toBe(3);
    for (let i = 0; i < responses.length; i++) {
      const result = responses[i].result;
      if (result.outcome === 'CREATED') continue;
      expect(result).toMatchObject({
        outcome: 'DENIED',
        denial: 'DELIVERY_CAPACITY_UNAVAILABLE',
        retryNotBeforeMicros: null,
        remainingWaitSeconds: null,
        deniedPolicyIds: [],
      });
      const value = values[i];
      if (value.kind !== 'SIGN_IN_REQUEST')
        throw new Error('Expected initial request.');
      expect(
        await prisma.authenticationChallenge.count({
          where: { normalizedIdentity: value.input.normalizedIdentity },
        }),
      ).toBe(0);
      expect(
        await prisma.authenticationChallengeSubject.count({
          where: { normalizedIdentity: value.input.normalizedIdentity },
        }),
      ).toBe(0);
      const aliases = track(value.input.normalizedIdentity);
      expect(
        await prisma.gcraRateLimit.count({
          where: { key: { in: aliases.email } },
        }),
      ).toBe(0);
      expect(
        await prisma.authenticationRateLimit.count({
          where: { key: { in: aliases.identity } },
        }),
      ).toBe(0);
    }
  });

  it('keeps capacity denial immutable and durable without a fabricated retry, even after a slot is freed', async () => {
    await fill();
    const value = request(),
      before = await state(),
      denied = await execute(value);
    expect(denied.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'DELIVERY_CAPACITY_UNAVAILABLE',
      retryNotBeforeMicros: null,
      remainingWaitSeconds: null,
    });
    expect(await state()).toEqual(before);
    await markTerminal('SENT');
    const freed = await state();
    expect(await operations.execute(denied.operationId, value)).toMatchObject({
      replayed: true,
      result: denied.result,
    });
    expect(await state()).toEqual(freed);
    expect((await operations.reconcile(denied.operationId, value)).status).toBe(
      'COMMITTED',
    );
    expect(await state()).toEqual(freed);
    expect((await execute(value, true)).result.outcome).toBe('CREATED');
    expect(await outstanding()).toBe(3);
  });

  it.each(['PENDING_DELAYED', 'PROCESSING', 'EXPIRED_LEASE'] as const)(
    'counts %s and resolves its unfinished work at capacity without changing retry/lease state',
    async (kind) => {
      await fill();
      const claim = await deliveries.claimNextDelivery();
      if (!claim) throw new Error('Expected claim.');
      if (kind === 'PENDING_DELAYED')
        expect(
          await deliveries.scheduleRetryAfter(
            claim.id,
            claim.leaseId,
            300,
            'TEST_RETRY',
          ),
        ).toBe('APPLIED');
      if (kind === 'EXPIRED_LEASE')
        await prisma.$executeRaw`UPDATE "AuthenticationChallengeDelivery" SET "processingLeaseExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE "id"=${claim.id}`;
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: claim.challengeId },
        }),
        before = await state();
      expect((await execute()).result).toMatchObject({
        outcome: 'DENIED',
        denial: 'DELIVERY_CAPACITY_UNAVAILABLE',
      });
      expect(await state()).toEqual(before);
      expect((await execute(resend(challenge), true)).result).toMatchObject({
        outcome: 'EXISTING',
        deliveryId: claim.id,
      });
      expect(await state()).toEqual(before);
      if (kind === 'EXPIRED_LEASE') {
        const recovered = await deliveries.claimNextDelivery();
        expect(recovered?.id).toBe(claim.id);
        expect(recovered?.claimKind).toBe('EXPIRED_LEASE_RECLAIM');
        expect(await outstanding()).toBe(3);
      }
    },
  );

  it.each(['SENT', 'FAILED', 'CANCELLED'] as const)(
    'releases capacity on %s through the real worker repository',
    async (kind) => {
      await fill();
      await markTerminal(kind);
      expect(await outstanding()).toBe(2);
      expect((await execute()).result.outcome).toBe('CREATED');
      expect(await outstanding()).toBe(3);
    },
  );

  it('allows REUSED/EXISTING even while another transaction holds the backlog row at full capacity', async () => {
    const [first] = await fill(),
      value = created(first),
      challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: value.challengeId },
      });
    const before = await state(),
      ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "AuthenticationDeliveryBacklogState" SET "updatedAt"=clock_timestamp() WHERE "id"=1`;
      ready.resolve();
      await release.promise;
      throw new Error('Rollback coordination fixture.');
    });
    void holding.catch(ready.reject);
    try {
      await ready.promise;
      expect(
        (
          await execute(
            {
              kind: 'SIGN_IN_REQUEST',
              input: {
                normalizedIdentity: challenge.normalizedIdentity,
                ipAddress: ip,
                templateProtocolVersion: 1,
              },
            },
            true,
          )
        ).result.outcome,
      ).toBe('REUSED');
      expect((await execute(resend(challenge), true)).result.outcome).toBe(
        'EXISTING',
      );
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
    }
    expect(await state()).toEqual(before);
  });

  it('denies a genuinely new RESEND without changing proof, TTL, GCRA or cooldown, then admits it after capacity release', async () => {
    const first = created(await execute());
    const claim = await deliveries.claimNextDelivery();
    expect(claim?.id).toBe(first.deliveryId);
    expect(await worker.process(claim!)).toEqual({ outcome: 'SENT' });
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: first.challengeId },
    });
    await allowInterval(challenge);
    await fill();
    const before = await state();
    expect((await execute(resend(challenge))).result).toMatchObject({
      outcome: 'DENIED',
      denial: 'DELIVERY_CAPACITY_UNAVAILABLE',
    });
    expect(await state()).toEqual(before);
    await markTerminal('SENT');
    const next = created(await execute(resend(challenge), true));
    expect(next.deliveryOrigin).toBe('RESEND');
    expect(await outstanding()).toBe(3);
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).toEqual(challenge);
  });

  it('sees a preceding ReadCommitted commit after waiting for the last slot', async () => {
    await fill(2);
    const first = input(),
      second = input(),
      ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      const result = await requests.requestSignInInTransaction(tx, first);
      expect(result.outcome).toBe('CREATED');
      ready.resolve();
      await release.promise;
      return result;
    });
    void holding.catch(ready.reject);
    let pending:
      | Promise<Awaited<ReturnType<typeof requests.requestSignInInTransaction>>>
      | undefined;
    try {
      await ready.promise;
      pending = transaction(
        (tx) => requests.requestSignInInTransaction(tx, second),
        replica,
      );
      await waitForLock();
      release.resolve();
      await holding;
      expect(await pending).toEqual({
        outcome: 'DELIVERY_CAPACITY_UNAVAILABLE',
      });
      expect(await outstanding()).toBe(3);
      expect(
        await prisma.authenticationChallenge.count({
          where: { normalizedIdentity: second.normalizedIdentity },
        }),
      ).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled(pending ? [holding, pending] : [holding]);
    }
  });

  it.each(['ReadCommitted', 'Serializable'] as const)(
    'aborts a stale Serializable snapshot after a %s admission and safely retries the whole owner',
    async (firstIsolation) => {
      await fill(2);
      const stale = input(),
        fresh = input(),
        ready = deferred(),
        proceed = deferred();
      const pending = transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT count(*) FROM "AuthenticationChallengeDelivery"`;
          ready.resolve();
          await proceed.promise;
          return requests.requestSignInInTransaction(tx, stale);
        },
        replica,
        'Serializable',
      );
      void pending.catch(() => undefined);
      try {
        await ready.promise;
        expect(
          (
            await transaction(
              (tx) => requests.requestSignInInTransaction(tx, fresh),
              prisma,
              firstIsolation,
            )
          ).outcome,
        ).toBe('CREATED');
        const committed = await state();
        proceed.resolve();
        await expect(pending).rejects.toMatchObject({
          reason: 'TRANSACTION_ABORTED',
        });
        try {
          await pending;
        } catch (error) {
          expect(isRetryableGcraTransactionError(error)).toBe(true);
        }
        expect(await state()).toEqual(committed);
        expect(
          await transaction(
            (tx) => requests.requestSignInInTransaction(tx, stale),
            replica,
            'Serializable',
          ),
        ).toEqual({ outcome: 'DELIVERY_CAPACITY_UNAVAILABLE' });
        expect(await state()).toEqual(committed);
        expect(await outstanding()).toBe(3);
      } finally {
        proceed.resolve();
        await Promise.allSettled([pending]);
      }
    },
  );

  it('rolls a successful reservation, new challenge, charges and cooldown back on later owner failure', async () => {
    await fill(2);
    const value = input(),
      before = await state();
    await expect(
      transaction(async (tx) => {
        expect(
          (await requests.requestSignInInTransaction(tx, value)).outcome,
        ).toBe('CREATED');
        throw new Error('Owner failed.');
      }),
    ).rejects.toThrow('Owner failed.');
    expect(await state()).toEqual(before);
    expect((await execute(request(value))).result.outcome).toBe('CREATED');
    expect(await outstanding()).toBe(3);
  });

  it('fails closed on a missing coordination row without recreating it or disguising the error as capacity denial', async () => {
    const value = input(),
      before = await state();
    await expect(
      transaction(async (tx) => {
        await tx.authenticationDeliveryBacklogState.delete({
          where: { id: 1 },
        });
        return requests.requestSignInInTransaction(tx, value);
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(await state()).toEqual(before);
  });

  it('rolls back all admission mutations on late SQL failure even if caught by the owner', async () => {
    const value = input(),
      before = await state(),
      schema = `backlog_fault_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`,
      marker = `backlog-owner:${randomUUID()}`;
    ownerSubjects.add(marker);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_insert() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."idempotencyKey"=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected persistence failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuthenticationChallengeDelivery" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_insert('${value.idempotencyKey}')`,
      );
      await transaction(async (tx) => {
        await tx.authenticationChallengeSubject.create({
          data: { key: marker },
        });
        await expect(
          requests.requestSignInInTransaction(tx, value),
        ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
      });
      expect(await state()).toEqual(before);
      expect(
        await prisma.authenticationChallengeSubject.findUnique({
          where: { key: marker },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationChallengeDelivery"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it.each(['expiry', 'window'] as const)(
    'rechecks %s after backlog-row waiting before returning a capacity denial',
    async (kind) => {
      const target = created(await execute());
      await markTerminal('SENT');
      await fill();
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: target.challengeId },
      });
      await allowInterval(challenge);
      const seconds =
        kind === 'expiry'
          ? 0
          : module.get(AuthenticationDeliveryPolicyService)
              .minValidityRemainingSeconds;
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()+${seconds}::integer*INTERVAL '1 second'+INTERVAL '800 milliseconds' WHERE "id"=${challenge.id}`;
      const ready = deferred(),
        release = deferred();
      const holding = transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "AuthenticationDeliveryBacklogState" SET "updatedAt"=clock_timestamp() WHERE "id"=1`;
        ready.resolve();
        await release.promise;
      });
      void holding.catch(ready.reject);
      let pending:
        | Promise<
            Awaited<ReturnType<typeof admission.admitResendInTransaction>>
          >
        | undefined;
      try {
        await ready.promise;
        const before = await state();
        pending = transaction(
          (tx) =>
            admission.admitResendInTransaction(tx, {
              challengeId: challenge.id,
              ipAddress: ip,
              idempotencyKey: randomUUID(),
              templateProtocolVersion: 1,
              retentionExpiresAt: challenge.retentionExpiresAt,
            }),
          replica,
        );
        await waitForLock();
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release.resolve();
        await holding;
        expect(await pending).toEqual({
          outcome:
            kind === 'expiry'
              ? 'CHALLENGE_UNAVAILABLE'
              : 'DELIVERY_WINDOW_CLOSED',
        });
        const after = await state();
        expect(after.challenges).toEqual(before.challenges);
        expect(after.deliveries).toEqual(before.deliveries);
        expect(after.gcra).toEqual(before.gcra);
        expect(after.cd).toEqual(before.cd);
      } finally {
        release.resolve();
        await Promise.allSettled(pending ? [holding, pending] : [holding]);
      }
    },
  );

  it('allows cleanup to free a retained slot at full backlog without acquiring the admission row', async () => {
    const [first] = await fill();
    const id = created(first).challengeId;
    await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()-INTERVAL '2 seconds',"retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE "id"=${id}`;
    const ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "AuthenticationDeliveryBacklogState" SET "updatedAt"=clock_timestamp() WHERE "id"=1`;
      ready.resolve();
      await release.promise;
    });
    void holding.catch(ready.reject);
    try {
      await ready.promise;
      expect(
        await new AuthenticationChallengeCleanupRepository(
          replica,
        ).deleteOneRetainedChallengeBatch(100),
      ).toBe(1);
      expect(await outstanding()).toBe(2);
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
    }
    expect((await execute()).result.outcome).toBe('CREATED');
    expect(await outstanding()).toBe(3);
  });

  it('preserves independently committed request accounting on capacity denial', async () => {
    await fill();
    const value = request(),
      config = module.get(HttpRequestRateLimitConfigService),
      requestAdmission = module.get(GcraAdmissionService);
    expect(
      (
        await requestAdmission.consume({
          policy: PUBLIC_PASSWORDLESS_REQUEST_POLICY,
          settings: config.publicPasswordless,
          characteristic: ip,
        })
      ).allowed,
    ).toBe(true);
    const before = await state();
    expect((await execute(value)).result).toMatchObject({
      outcome: 'DENIED',
      denial: 'DELIVERY_CAPACITY_UNAVAILABLE',
    });
    expect(await state()).toEqual(before);
  });
});
