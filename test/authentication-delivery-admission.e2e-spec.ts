import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Prisma } from '../src/generated/prisma/client';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationDeliveryPolicyService } from '../src/auth/delivery/services/authentication-delivery-policy.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryRateLimitService } from '../src/auth/rate-limit/services/authentication-delivery-rate-limit.service';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import { chargeGcra } from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';

type Fixture = { challengeId: string; identity: string; ipAddress: string };

describe('RESEND Delivery admission (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const subjects = new Set<string>();
  const ownedKeys = new Set<string>();
  const replicaName = `resend_admission_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let module: TestingModule;
  let prisma: PrismaService;
  let replica: PrismaService;
  let service: AuthenticationDeliveryAdmissionService;
  let replicaService: AuthenticationDeliveryAdmissionService;
  let repository: AuthenticationDeliveryRepository;
  let factory: AuthenticationChallengeProofFactoryService;
  let derivation: RateLimitBucketKeyService;
  let gcra: GcraAdmissionRepository;
  let cooldown: AuthenticationDeliveryCooldownRepository;
  let rateConfig: AuthenticationRateLimitConfigService;
  let fixture: Fixture;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = module.get(PrismaService);
    const config = module.get(ConfigService);
    const url = new URL(config.getOrThrow<string>('DATABASE_URL'));
    if (!url.pathname.endsWith('_test'))
      throw new Error('Admission tests require a dedicated test database.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    service = module.get(AuthenticationDeliveryAdmissionService);
    repository = module.get(AuthenticationDeliveryRepository);
    replicaService = new AuthenticationDeliveryAdmissionService(
      new AuthenticationDeliveryRepository(
        replica,
        module.get(AuthenticationDeliveryPolicyService),
      ),
      module.get(AuthenticationDeliveryRateLimitService),
      module.get(AuthenticationDeliveryPolicyService),
    );
    factory = module.get(AuthenticationChallengeProofFactoryService);
    derivation = module.get(RateLimitBucketKeyService);
    gcra = module.get(GcraAdmissionRepository);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
    rateConfig = module.get(AuthenticationRateLimitConfigService);
  });

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { in: [...subjects] } },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    subjects.clear();
    ownedKeys.clear();
  });

  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  async function createFixture(
    identity = `student-${randomUUID()}@example.edu`,
  ): Promise<Fixture> {
    const challengeId = randomUUID();
    const subjectKey = `e2e:resend-admission:${challengeId}`;
    subjects.add(subjectKey);
    const proof = factory.generate({
      challengeId,
      purpose: 'SIGN_IN',
      normalizedIdentity: identity,
    });
    await prisma.authenticationChallenge.create({
      data: {
        id: challengeId,
        subject: { create: { key: subjectKey } },
        purpose: 'SIGN_IN',
        identityType: 'INSTITUTIONAL_EMAIL',
        normalizedIdentity: identity,
        ...proof.persistence.hashing,
        ...proof.persistence.encryption,
        otpHash: Uint8Array.from(proof.persistence.hashing.otpHash),
        linkTokenHash: Uint8Array.from(proof.persistence.hashing.linkTokenHash),
        encryptedProof: Uint8Array.from(
          proof.persistence.encryption.encryptedProof,
        ),
        proofEncryptionIv: Uint8Array.from(
          proof.persistence.encryption.proofEncryptionIv,
        ),
        proofEncryptionTag: Uint8Array.from(
          proof.persistence.encryption.proofEncryptionTag,
        ),
        expiresAt: new Date(Date.now() + 600_000),
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const result = {
      challengeId,
      identity,
      ipAddress: `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
    };
    keys(result);
    return result;
  }

  function keys(value = fixture) {
    const result = {
      challenge: derivation
        .deriveKeys(policies.challengeDeliveryCooldown, value.challengeId)
        .buckets.map((b) => b.key),
      identity: derivation
        .deriveKeys(policies.identityDeliveryCooldown, value.identity)
        .buckets.map((b) => b.key),
      emailGcra: derivation
        .deriveKeys(policies.deliveryIdentity, value.identity)
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

  function input(value = fixture) {
    keys(value);
    return {
      challengeId: value.challengeId,
      ipAddress: value.ipAddress,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
    };
  }

  function admit(value = fixture, other = false) {
    const captured = input(value);
    return (other ? replica : prisma).$transaction(
      (tx) =>
        (other ? replicaService : service).admitResendInTransaction(
          tx,
          captured,
        ),
      { timeout: 10_000 },
    );
  }

  async function state(value = fixture) {
    const all = Object.values(keys(value)).flat();
    return {
      challenge: await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: value.challengeId },
      }),
      deliveries: await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId: value.challengeId },
        orderBy: { id: 'asc' },
      }),
      cd: await prisma.$queryRaw<
        { key: string; count: number; boundary: string; updated: string }[]
      >(Prisma.sql`
        SELECT "key","count",trunc(EXTRACT(EPOCH FROM "windowEndAt")*1000000)::text AS boundary,"updatedAt"::text AS updated
        FROM "AuthenticationRateLimit" WHERE "key" IN (${Prisma.join(all)}) ORDER BY "key"`),
      gcra: await prisma.gcraRateLimit.findMany({
        where: { key: { in: all } },
        orderBy: { key: 'asc' },
      }),
    };
  }

  async function existing(
    status: 'PENDING' | 'PROCESSING' | 'SENT' = 'PENDING',
    value = fixture,
    idempotencyKey = randomUUID(),
  ) {
    return prisma.authenticationChallengeDelivery.create({
      data: {
        challengeId: value.challengeId,
        method: 'EMAIL',
        origin: 'INITIAL',
        recipientSnapshot: value.identity,
        idempotencyKey,
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
        status,
        ...(status === 'SENT'
          ? { sentAt: new Date() }
          : status === 'PROCESSING'
            ? {
                attemptCount: 1,
                processingLeaseId: randomUUID(),
                processingLeaseExpiresAt: new Date(Date.now() + 45_000),
              }
            : {
                attemptCount: 1,
                nextAttemptAt: new Date(Date.now() + 90_000),
                lastSafeFailureCode: 'PROVIDER_UNAVAILABLE',
              }),
      },
    });
  }

  it('commits a RESEND with one exact charge per policy and both cooldowns, preserving challenge/proof', async () => {
    const before = await state();
    const result = await admit();
    expect(result.outcome).toBe('CREATED');
    if (result.outcome !== 'CREATED') throw new Error('Expected creation.');
    const after = await state();
    expect(after.challenge).toEqual(before.challenge);
    expect(after.deliveries).toHaveLength(1);
    expect(after.deliveries[0]).toMatchObject({
      id: result.delivery.id,
      origin: 'RESEND',
      status: 'PENDING',
      recipientSnapshot: fixture.identity,
    });
    expect(after.cd).toHaveLength(
      keys().challenge.length + keys().identity.length,
    );
    for (const row of after.cd)
      expect(row).toMatchObject({
        count: 1,
        boundary: (result.operationNowMicros + 60_000_000n).toString(),
      });
    expect(after.gcra).toHaveLength(
      keys().emailGcra.length + keys().ipGcra.length,
    );
    for (const row of after.gcra)
      expect(fromGcraPersistenceData(row)).toEqual(
        chargeGcra(
          null,
          row.policyId === policies.deliveryIdentity.id
            ? rateConfig.deliveryIdentity
            : rateConfig.deliveryIp,
          result.operationNowMicros,
        ),
      );
  });

  it.each(['PENDING', 'PROCESSING'] as const)(
    'returns existing %s even in a closed new-Delivery window without touching any fields or budgets',
    async (status) => {
      const old = await existing(status);
      await prisma.authenticationChallenge.update({
        where: { id: fixture.challengeId },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      });
      await prisma.$transaction((tx) =>
        cooldown.writeAliases(
          tx,
          keys().identity,
          BigInt(Date.now()) * 1_000n + 60_000_000n,
        ),
      );
      const before = await state();
      expect(await admit()).toMatchObject({
        outcome: 'EXISTING',
        delivery: {
          id: old.id,
          idempotencyKey: old.idempotencyKey,
          origin: 'INITIAL',
        },
      });
      expect(await state()).toEqual(before);
    },
  );

  it('denies active cooldown without a new Delivery, charge, boundary movement or proof changes', async () => {
    expect((await admit()).outcome).toBe('CREATED');
    await prisma.authenticationChallengeDelivery.updateMany({
      where: { challengeId: fixture.challengeId },
      data: { status: 'SENT', sentAt: new Date() },
    });
    const before = await state();
    const result = await admit();
    expect(result).toMatchObject({ outcome: 'RATE_LIMITED' });
    if (result.outcome !== 'RATE_LIMITED') throw new Error('Expected denial.');
    expect(result.retryAfterSeconds).toBeGreaterThan(0n);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60n);
    expect(await state()).toEqual(before);
  });

  it.each(['emailGcra', 'ipGcra'] as const)(
    'denies exhausted %s without starting either cooldown or creating work',
    async (group) => {
      const now = await gcra.operationNowMicros(prisma);
      const policy =
        group === 'emailGcra' ? policies.deliveryIdentity : policies.deliveryIp;
      const settings =
        group === 'emailGcra'
          ? rateConfig.deliveryIdentity
          : rateConfig.deliveryIp;
      let exhausted = chargeGcra(null, settings, now);
      for (let count = 1; count < settings.burst; count++) {
        exhausted = chargeGcra(exhausted, settings, now);
      }
      await prisma.$transaction((tx) =>
        gcra.writeAliases(tx, keys()[group], policy.id, exhausted),
      );
      const before = await state();
      expect(await admit()).toMatchObject({
        outcome: 'RATE_LIMITED',
        deniedPolicyIds: [policy.id],
      });
      expect(await state()).toEqual(before);
    },
  );

  it.each(['expired', 'consumed', 'locked', 'envelope'] as const)(
    'rejects an unavailable challenge (%s) without touching unfinished work or budgets',
    async (reason) => {
      await existing();
      await prisma.authenticationChallenge.update({
        where: { id: fixture.challengeId },
        data: {
          ...(reason === 'expired'
            ? { expiresAt: new Date(Date.now() - 1_000) }
            : {}),
          ...(reason === 'consumed' ? { consumedAt: new Date() } : {}),
          ...(reason === 'locked' ? { lockedAt: new Date() } : {}),
          ...(['consumed', 'locked', 'envelope'].includes(reason)
            ? {
                encryptedProof: null,
                proofEncryptionIv: null,
                proofEncryptionTag: null,
              }
            : {}),
        },
      });
      const before = await state();
      expect(await admit()).toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
      expect(await state()).toEqual(before);
    },
  );

  it('resolves existing work above the former attempt threshold without charging Delivery policies', async () => {
    const delivery = await existing();
    await prisma.authenticationChallenge.update({
      where: { id: fixture.challengeId },
      data: { failedAttemptCount: 9 },
    });
    const before = await state();
    expect(await admit()).toMatchObject({
      outcome: 'EXISTING',
      delivery: { id: delivery.id },
    });
    expect(await state()).toEqual(before);
  });

  it('rejects missing challenges without any persisted admission', async () => {
    expect(await admit({ ...fixture, challengeId: randomUUID() })).toEqual({
      outcome: 'CHALLENGE_UNAVAILABLE',
    });
    expect((await state()).deliveries).toHaveLength(0);
    expect((await state()).cd).toHaveLength(0);
    expect((await state()).gcra).toHaveLength(0);
  });

  it('denies a live challenge with less than 120 seconds remaining before any writes', async () => {
    await prisma.authenticationChallenge.update({
      where: { id: fixture.challengeId },
      data: { expiresAt: new Date(Date.now() + 119_000) },
    });
    const before = await state();
    expect(await admit()).toEqual({ outcome: 'DELIVERY_WINDOW_CLOSED' });
    expect(await state()).toEqual(before);
  });

  it('serializes same-challenge resends across clients, charging once and resolving the same work', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => admit(fixture, i % 2 === 1)),
    );
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'EXISTING')).toHaveLength(11);
    const after = await state();
    expect(after.deliveries).toHaveLength(1);
    for (const result of results)
      expect(result).toMatchObject({
        delivery: { id: after.deliveries[0].id },
      });
    const created = results.find((r) => r.outcome === 'CREATED')!;
    if (created.outcome !== 'CREATED') throw new Error('Expected creation.');
    for (const row of after.gcra)
      expect(fromGcraPersistenceData(row)).toEqual(
        chargeGcra(
          null,
          row.policyId === policies.deliveryIdentity.id
            ? rateConfig.deliveryIdentity
            : rateConfig.deliveryIp,
          created.operationNowMicros,
        ),
      );
  });

  it('serializes different challenges/IPs sharing one identity without charging losing requests', async () => {
    const fixtures = [
      fixture,
      ...(await Promise.all(
        Array.from({ length: 7 }, () => createFixture(fixture.identity)),
      )),
    ];
    const results = await Promise.all(
      fixtures.map((value, i) => admit(value, i % 2 === 1)),
    );
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'RATE_LIMITED')).toHaveLength(7);
    for (const [index, value] of fixtures.entries()) {
      const after = await state(value);
      expect(after.deliveries).toHaveLength(
        results[index].outcome === 'CREATED' ? 1 : 0,
      );
      if (results[index].outcome !== 'CREATED') {
        expect(
          after.cd.filter((row) => keys(value).challenge.includes(row.key)),
        ).toHaveLength(0);
        expect(
          after.gcra.filter((row) => keys(value).ipGcra.includes(row.key)),
        ).toHaveLength(0);
      }
    }
  });

  it('rolls back Delivery, cooldowns and charges when the outer owner fails', async () => {
    const before = await state();
    await expect(
      prisma.$transaction(async (tx) => {
        expect(
          (await service.admitResendInTransaction(tx, input())).outcome,
        ).toBe('CREATED');
        throw new Error('Owner failed.');
      }),
    ).rejects.toThrow('Owner failed.');
    expect(await state()).toEqual(before);
  });

  it('rolls back all charges on a real insert failure even if the owner catches it and commits earlier work', async () => {
    const other = await createFixture();
    const collision = await existing('SENT', other);
    const before = await state();
    const marker = `e2e:resend-admission:marker:${randomUUID()}`;
    subjects.add(marker);
    await prisma.$transaction(async (tx) => {
      await tx.authenticationChallengeSubject.create({ data: { key: marker } });
      await expect(
        service.admitResendInTransaction(tx, {
          ...input(),
          idempotencyKey: collision.idempotencyKey,
        }),
      ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    });
    expect(await state()).toEqual(before);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: marker },
      }),
    ).not.toBeNull();
    expect(
      await prisma.authenticationChallengeDelivery.findUnique({
        where: { id: collision.id },
      }),
    ).toEqual(collision);
  });

  it.each(['sent', 'failed', 'retry'] as const)(
    'does not change cooldown or GCRA when provider work transitions to %s',
    async (transition) => {
      expect((await admit()).outcome).toBe('CREATED');
      const before = await state();
      const claim = await repository.claimNextDelivery();
      if (!claim) throw new Error('Expected claim.');
      if (transition === 'sent')
        await repository.markSent(claim.id, claim.leaseId, 'test-message');
      else if (transition === 'failed')
        await repository.markFailed(
          claim.id,
          claim.leaseId,
          'PROVIDER_REJECTED',
        );
      else
        await repository.scheduleRetry(
          claim.id,
          claim.leaseId,
          new Date(Date.now() + 30_000),
          'PROVIDER_UNAVAILABLE',
        );
      const after = await state();
      expect(after.cd).toEqual(before.cd);
      expect(after.gcra).toEqual(before.gcra);
      expect(after.challenge).toEqual(before.challenge);
    },
  );

  it.each([
    { remaining: 120.8, outcome: 'DELIVERY_WINDOW_CLOSED' },
    { remaining: 0.8, outcome: 'CHALLENGE_UNAVAILABLE' },
  ])(
    'rechecks lifecycle/window after a real bucket wait ($outcome)',
    async ({ remaining, outcome }) => {
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()+${remaining}::double precision * INTERVAL '1 second' WHERE "id"=${fixture.challengeId}`;
      const before = await state();
      let ready!: (tx: Prisma.TransactionClient) => void;
      let release!: () => void;
      const readyPromise = new Promise<Prisma.TransactionClient>((resolve) => {
        ready = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = prisma.$transaction(
        async (tx) => {
          await gcra.lockAliases(tx, keys().identity);
          ready(tx);
          await releasePromise;
        },
        { timeout: 10_000 },
      );
      const control = await readyPromise;
      const pending = admit(fixture, true);
      try {
        let blocked = false;
        for (let i = 0; i < 100; i++) {
          const rows = await prisma.$queryRaw<
            { pid: number }[]
          >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
          if (rows.length) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await control.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release();
        await holding;
        expect(await pending).toEqual({ outcome });
        expect(await state()).toEqual(before);
      } finally {
        release();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  it('rejects root clients and unsupported isolation before any admission writes', async () => {
    await expect(
      service.admitResendInTransaction(prisma, input()),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      prisma.$transaction(
        (tx) => service.admitResendInTransaction(tx, input()),
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect((await state()).deliveries).toHaveLength(0);
  });

  it('permits a whole-owner retry after a confirmed insertion abort, committing one Delivery and one charge', async () => {
    const captured = input();
    const schema = `admission_abort_${randomUUID().replaceAll('-', '')}`;
    const trigger = `${schema}_trigger`;
    if (!/^[a-f0-9-]{36}$/.test(captured.idempotencyKey))
      throw new Error('Unexpected test key.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
      await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".fail_insert() RETURNS trigger LANGUAGE plpgsql AS $test$
        BEGIN IF NEW."idempotencyKey" = TG_ARGV[0] AND nextval('"${schema}".attempts') <= 1 THEN RAISE EXCEPTION 'Injected admission abort.' USING ERRCODE='40001'; END IF; RETURN NEW; END $test$`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuthenticationChallengeDelivery" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_insert('${captured.idempotencyKey}')`,
      );
      let attempts = 0;
      let committed: Awaited<ReturnType<typeof admit>> | undefined;
      while (attempts < 2) {
        attempts++;
        try {
          committed = await prisma.$transaction((tx) =>
            service.admitResendInTransaction(tx, captured),
          );
          break;
        } catch (error) {
          if (!isRetryableGcraTransactionError(error) || attempts === 2)
            throw error;
        }
      }
      expect(attempts).toBe(2);
      if (committed?.outcome !== 'CREATED')
        throw new Error('Expected committed admission.');
      const after = await state();
      expect(after.deliveries).toHaveLength(1);
      for (const row of after.cd)
        expect(row.boundary).toBe(
          (committed.operationNowMicros + 60_000_000n).toString(),
        );
      for (const row of after.gcra)
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(
            null,
            row.policyId === policies.deliveryIdentity.id
              ? rateConfig.deliveryIdentity
              : rateConfig.deliveryIp,
            committed.operationNowMicros,
          ),
        );
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationChallengeDelivery"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
