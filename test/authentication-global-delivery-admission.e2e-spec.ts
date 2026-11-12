import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type AuthenticationChallenge,
} from '../src/generated/prisma/client';

import { AuthModule } from '../src/auth/auth.module';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../src/auth/rate-limit/constants/authentication-global-delivery-admission.constants';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import {
  chargeGcra,
  createGcraState,
} from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import {
  AuthenticationEmailRetryKind,
  type AuthenticationEmailProviderResult,
  type AuthenticationEmailSubmission,
} from '../src/auth/delivery/types/authentication-email-provider.type';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
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
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { validateEnvironment } from '../src/config/environment.validation';
import { HttpRateLimitModule } from '../src/http-rate-limit/http-rate-limit.module';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY } from '../src/http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';

// Real admission/receipts/worker/cleanup and PostgreSQL. Only external email
// submission is replaced; no application service, repository or clock is mocked.
describe('Global auth Delivery creation admission (PostgreSQL)', () => {
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
  const sources = new Map<string, string>();
  const identities = new Set<string>(),
    operationIds = new Set<string>(),
    ownedKeys = new Set<string>(),
    ownerSubjects = new Set<string>();
  const replicaName = `backlog_rival_${randomUUID().replaceAll('-', '')}`;
  const provider = {
    submit: jest
      .fn<
        Promise<AuthenticationEmailProviderResult>,
        [AuthenticationEmailSubmission]
      >()
      .mockResolvedValue({ outcome: 'ACCEPTED' }),
  };
  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: (env) =>
            validateEnvironment({
              ...env,
              AUTH_DELIVERY_BACKLOG_LIMIT: '20',
              AUTH_DELIVERY_GLOBAL_BURST: '3',
              AUTH_DELIVERY_GLOBAL_RATE: '3',
              AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS: '3600',
              AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS: '1',
            }),
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
    expect(
      module.get(AuthenticationRateLimitConfigService).deliveryGlobal,
    ).toEqual({ burst: 3, rate: 3, periodSeconds: 3600 });
    // Dedicated-DB fixture transition from other suites' large test defaults.
    // Runtime configuration changes must not silently reset persisted debt.
    await prisma.gcraRateLimit.deleteMany({
      where: { key: globalAdmission.key },
    });
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
    sources.clear();
    identities.clear();
    operationIds.clear();
    ownedKeys.clear();
    ownerSubjects.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function input(sourceIp = ip) {
    const normalizedIdentity = `backlog-${randomUUID()}@example.edu`;
    identities.add(normalizedIdentity);
    sources.set(normalizedIdentity, sourceIp);
    track(normalizedIdentity);
    return {
      normalizedIdentity,
      ipAddress: sourceIp,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
    };
  }
  function request(value = input()): AuthenticationOperationRequest {
    return {
      kind: 'SIGN_IN_REQUEST',
      input: {
        normalizedIdentity: value.normalizedIdentity,
        ipAddress: value.ipAddress,
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
        ipAddress: sources.get(challenge.normalizedIdentity) ?? ip,
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
        .deriveKeys(policies.deliveryIp, sources.get(identity) ?? ip)
        .buckets.map((b) => b.key),
      request: derivation
        .deriveKeys(
          PUBLIC_PASSWORDLESS_REQUEST_POLICY,
          sources.get(identity) ?? ip,
        )
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

  async function seedBoundary(
    boundary: bigint,
    global = true,
    identity?: string,
  ) {
    const settings = global
      ? module.get(AuthenticationRateLimitConfigService).deliveryGlobal
      : module.get(AuthenticationRateLimitConfigService).deliveryIdentity;
    const policyId = global
      ? globalAdmission.policyId
      : policies.deliveryIdentity.id;
    const keys = global ? [globalAdmission.key] : track(identity!).email;
    await transaction((tx) =>
      module.get(GcraAdmissionRepository).writeAliases(
        tx,
        keys,
        policyId,
        createGcraState(
          {
            numerator:
              boundary * BigInt(settings.rate) +
              BigInt(settings.burst - 1) *
                BigInt(settings.periodSeconds) *
                1_000_000n,
            denominator: BigInt(settings.rate),
          },
          settings,
        ),
      ),
    );
  }
  function globalState() {
    return prisma.gcraRateLimit.findUnique({
      where: { key: globalAdmission.key },
    });
  }
  async function now() {
    return module.get(GcraAdmissionRepository).operationNowMicros(prisma);
  }

  it('admits exactly three concurrent INITIALs across identities, IPs and clients and charges one shared state', async () => {
    const values = Array.from({ length: 9 }, () =>
      request(
        input(
          `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
        ),
      ),
    );
    const responses = await Promise.all(
      values.map((value, i) => execute(value, i % 2 === 1)),
    );
    const accepted = responses.filter(
      (response) => response.result.outcome === 'CREATED',
    );
    expect(accepted).toHaveLength(3);
    expect(await outstanding()).toBe(3);
    const times = accepted
        .map((response) => created(response).admissionNowMicros)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      settings = module.get(
        AuthenticationRateLimitConfigService,
      ).deliveryGlobal;
    let expected = chargeGcra(null, settings, times[0]);
    for (const time of times.slice(1))
      expected = chargeGcra(expected, settings, time);
    expect(fromGcraPersistenceData((await globalState())!)).toEqual(expected);
    for (let i = 0; i < responses.length; i++) {
      const result = responses[i].result,
        value = values[i];
      if (value.kind !== 'SIGN_IN_REQUEST')
        throw new Error('Expected initial request.');
      if (result.outcome === 'CREATED') continue;
      expect(result).toMatchObject({
        outcome: 'DENIED',
        denial: 'GLOBAL_RATE_DENIED',
        deniedPolicyIds: [globalAdmission.policyId],
      });
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
          where: { key: { in: [...aliases.email, ...aliases.ip] } },
        }),
      ).toBe(0);
      expect(
        await prisma.authenticationRateLimit.count({
          where: { key: { in: aliases.identity } },
        }),
      ).toBe(0);
    }
  });

  it('bypasses exhausted and locked global state for REUSED and EXISTING without consuming another unit', async () => {
    const [first] = await fill(),
      value = created(first),
      challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: value.challengeId },
      }),
      before = await state();
    const ready = deferred(),
      release = deferred();
    const holding = transaction(async (tx) => {
      await module
        .get(GcraAdmissionRepository)
        .lockAliases(tx, [globalAdmission.key]);
      await tx.$queryRaw`SELECT "key" FROM "GcraRateLimit" WHERE "key"=${globalAdmission.key} FOR UPDATE`;
      ready.resolve();
      await release.promise;
    });
    void holding.catch(ready.reject);
    try {
      await ready.promise;
      const req: AuthenticationOperationRequest = {
        kind: 'SIGN_IN_REQUEST',
        input: {
          normalizedIdentity: challenge.normalizedIdentity,
          ipAddress: ip,
          templateProtocolVersion: 1,
        },
      };
      expect((await execute(req, true)).result.outcome).toBe('REUSED');
      expect((await execute(resend(challenge), true)).result.outcome).toBe(
        'EXISTING',
      );
    } finally {
      release.resolve();
      await Promise.allSettled([holding]);
    }
    expect(await state()).toEqual(before);
  });

  it('shares INITIAL/RESEND capacity and sends stable proof after a controlled global recovery fixture', async () => {
    const first = created(await execute());
    const claim = await deliveries.claimNextDelivery();
    expect(claim?.id).toBe(first.deliveryId);
    expect(await worker.process(claim!)).toEqual({ outcome: 'SENT' });
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: first.challengeId },
    });
    await allowInterval(challenge);
    await fill(2);
    const before = await state();
    expect((await execute(resend(challenge))).result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
    });
    expect(await state()).toEqual(before);
    // Historical global recovery fixture, not a claim of elapsed replenishment.
    await seedBoundary((await now()) - 1_000_000n);
    const recovered = (await globalState())!,
      response = created(await execute(resend(challenge), true));
    expect(response.deliveryOrigin).toBe('RESEND');
    expect(fromGcraPersistenceData((await globalState())!)).toEqual(
      chargeGcra(
        fromGcraPersistenceData(recovered),
        module.get(AuthenticationRateLimitConfigService).deliveryGlobal,
        response.admissionNowMicros,
      ),
    );
    const resendClaim = await deliveries.claimNextDelivery();
    // Other INITIALs precede RESEND; terminalize them without submitting mail.
    if (resendClaim?.id !== response.deliveryId) {
      if (!resendClaim) throw new Error('Expected claim.');
      await deliveries.markSent(resendClaim.id, resendClaim.leaseId, 'fixture');
      await markTerminal('SENT');
      const target = await deliveries.claimNextDelivery();
      expect(target?.id).toBe(response.deliveryId);
      expect(await worker.process(target!)).toEqual({ outcome: 'SENT' });
    } else
      expect(await worker.process(resendClaim)).toEqual({ outcome: 'SENT' });
    expect(provider.submit).toHaveBeenCalledTimes(2);
    expect(provider.submit.mock.calls[1][0].content).toEqual(
      provider.submit.mock.calls[0][0].content,
    );
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challenge.id },
      }),
    ).toEqual(challenge);
  });

  it('never recharges global admission when the provider retries the same Delivery', async () => {
    const first = created(await execute()),
      before = await globalState();
    provider.submit.mockResolvedValueOnce({
      outcome: 'RETRYABLE',
      retryKind: AuthenticationEmailRetryKind.SAFE_RETRY,
      safeFailureCode: 'TEST_RETRY',
    });
    const claim = await deliveries.claimNextDelivery();
    expect(claim?.id).toBe(first.deliveryId);
    expect(await worker.process(claim!)).toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    expect(await globalState()).toEqual(before);
    await prisma.$executeRaw`UPDATE "AuthenticationChallengeDelivery" SET "nextAttemptAt"=clock_timestamp()-INTERVAL '1 second' WHERE "id"=${first.deliveryId}`;
    const retry = await deliveries.claimNextDelivery();
    expect(retry?.id).toBe(first.deliveryId);
    expect(await worker.process(retry!)).toEqual({ outcome: 'SENT' });
    expect(await globalState()).toEqual(before);
    expect(provider.submit).toHaveBeenCalledTimes(2);
    expect(provider.submit.mock.calls[0][0].idempotencyKey).toBe(
      provider.submit.mock.calls[1][0].idempotencyKey,
    );
  });

  it.each(['cooldown', 'identity'] as const)(
    'does not charge global state on personal %s denial',
    async (kind) => {
      const first = created(await execute());
      await markTerminal('SENT');
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: first.challengeId },
      });
      if (kind === 'identity') {
        await allowInterval(challenge);
        await seedBoundary(
          (await now()) + 30_000_000n,
          false,
          challenge.normalizedIdentity,
        );
      }
      const before = await state();
      expect((await execute(resend(challenge))).result).toMatchObject({
        outcome: 'DENIED',
        denial: 'RATE_LIMITED',
      });
      expect(await state()).toEqual(before);
    },
  );

  it('attributes joint denial to global policy but retains the latest boundary across every denying policy', async () => {
    const first = created(await execute());
    await markTerminal('SENT');
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: first.challengeId },
      }),
      time = await now(),
      latest = time + 90_000_001n;
    await seedBoundary(time + 10_000_001n);
    await seedBoundary(latest, false, challenge.normalizedIdentity);
    const before = await state(),
      req = resend(challenge),
      response = await execute(req);
    expect(response.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
      retryNotBeforeMicros: latest,
      deniedPolicyIds: [
        policies.challengeDeliveryCooldown.id,
        globalAdmission.policyId,
        policies.deliveryIdentity.id,
        policies.identityDeliveryCooldown.id,
      ].sort(),
    });
    if (response.result.outcome !== 'DENIED')
      throw new Error('Expected denial.');
    expect(response.result.remainingWaitSeconds).toBeGreaterThan(0n);
    expect(await state()).toEqual(before);
    const receipt = await prisma.authenticationOperation.findUniqueOrThrow({
      where: { id: response.operationId },
    });
    expect(receipt.retryNotBeforeMicros?.toFixed(0)).toBe(latest.toString());
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(0.02)`;
    const replay = await operations.execute(response.operationId, req);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
      retryNotBeforeMicros: latest,
    });
    expect((await operations.reconcile(response.operationId, req)).status).toBe(
      'COMMITTED',
    );
    expect(await state()).toEqual(before);
  });

  it('rejects a global-key/policy mismatch at the database boundary', async () => {
    await execute();
    const before = await state();
    await expect(
      prisma.gcraRateLimit.update({
        where: { key: globalAdmission.key },
        data: { policyId: 'CORRUPT_FIXTURE' },
      }),
    ).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it('fails closed on incompatible global configuration even if cooldown already denies', async () => {
    const first = created(await execute());
    await markTerminal('SENT');
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: first.challengeId },
    });
    await prisma.gcraRateLimit.update({
      where: { key: globalAdmission.key },
      data: { burst: 4 },
    });
    const before = await state();
    await expect(execute(resend(challenge))).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    expect(await state()).toEqual(before);
  });

  it('rolls a global charge back with the whole owner and charges only once on a new successful attempt', async () => {
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
    const response = created(await execute(request(value)));
    expect(fromGcraPersistenceData((await globalState())!)).toEqual(
      chargeGcra(
        null,
        module.get(AuthenticationRateLimitConfigService).deliveryGlobal,
        response.admissionNowMicros,
      ),
    );
  });

  it('rolls global/personal charges, cooldown and new challenge back on late SQL insert failure caught by the owner', async () => {
    const value = input(),
      before = await state(),
      schema = `global_admission_fault_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`,
      marker = `global-owner:${randomUUID()}`;
    ownerSubjects.add(marker);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_insert() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."idempotencyKey"=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected global admission failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`,
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

  it.each([
    { wait: 1.1, outcome: 'DELIVERY_WINDOW_CLOSED' },
    { wait: 2.1, outcome: 'CHALLENGE_UNAVAILABLE' },
  ])(
    'rechecks $outcome after waiting for the global bucket',
    async ({ wait, outcome }) => {
      const first = created(await execute());
      await markTerminal('SENT');
      const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: first.challengeId },
      });
      await allowInterval(challenge);
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()+INTERVAL '1.8 seconds' WHERE "id"=${challenge.id}`;
      const before = await state(),
        ready = deferred(),
        release = deferred();
      const holding = transaction(async (tx) => {
        await module
          .get(GcraAdmissionRepository)
          .lockAliases(tx, [globalAdmission.key]);
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
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(${wait})`;
        release.resolve();
        await holding;
        expect(await pending).toEqual({ outcome });
        expect(await state()).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled(pending ? [holding, pending] : [holding]);
      }
    },
  );

  it('permits new admission after the actual persisted global eligibility boundary without a periodic reset', async () => {
    await seedBoundary((await now()) + 700_000n);
    const value = request(),
      denied = await execute(value);
    expect(denied.result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
    });
    if (
      denied.result.outcome !== 'DENIED' ||
      denied.result.retryNotBeforeMicros === null
    )
      throw new Error('Expected rate boundary.');
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${denied.result.retryNotBeforeMicros.toString()}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
    const prior = (await globalState())!,
      createdNow = created(await execute(value, true));
    expect(fromGcraPersistenceData((await globalState())!)).toEqual(
      chargeGcra(
        fromGcraPersistenceData(prior),
        module.get(AuthenticationRateLimitConfigService).deliveryGlobal,
        createdNow.admissionNowMicros,
      ),
    );
    expect(
      (await operations.execute(denied.operationId, value)).result,
    ).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
      remainingWaitSeconds: 0n,
    });
  });

  it('retains global debt through real challenge/Delivery retention cleanup', async () => {
    await fill();
    await prisma.$executeRaw(
      Prisma.sql`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()-INTERVAL '2 seconds',"retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE "normalizedIdentity" IN (${Prisma.join([...identities])})`,
    );
    const debt = await globalState();
    expect(
      await module
        .get(AuthenticationChallengeCleanupRepository)
        .deleteOneRetainedChallengeBatch(100),
    ).toBe(3);
    expect(await outstanding()).toBe(0);
    expect(await globalState()).toEqual(debt);
    const before = await state();
    expect((await execute()).result).toMatchObject({
      outcome: 'DENIED',
      denial: 'GLOBAL_RATE_DENIED',
    });
    expect(await state()).toEqual(before);
  });
  it.each(['global', 'personal'] as const)(
    'rejects inconsistent receipt classification (%s) in PostgreSQL',
    async (kind) => {
      let response: AuthenticationOperationResponse;
      if (kind === 'global') {
        await fill();
        response = await execute();
      } else {
        const first = created(await execute());
        await markTerminal('SENT');
        const challenge =
          await prisma.authenticationChallenge.findUniqueOrThrow({
            where: { id: first.challengeId },
          });
        response = await execute(resend(challenge));
      }
      const before = await prisma.authenticationOperation.findUniqueOrThrow({
        where: { id: response.operationId },
      });
      expect(before.denial).toBe(
        kind === 'global' ? 'GLOBAL_RATE_DENIED' : 'RATE_LIMITED',
      );
      await expect(
        prisma.authenticationOperation.update({
          where: { id: response.operationId },
          data: {
            denial: kind === 'global' ? 'RATE_LIMITED' : 'GLOBAL_RATE_DENIED',
          },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.authenticationOperation.findUniqueOrThrow({
          where: { id: response.operationId },
        }),
      ).toEqual(before);
    },
  );
});
