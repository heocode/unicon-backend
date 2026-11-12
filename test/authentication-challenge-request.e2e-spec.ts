import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { Prisma } from '../src/generated/prisma/client';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AuthenticationChallengeRequestRepository } from '../src/auth/challenge/repositories/authentication-challenge-request.repository';
import { AuthenticationChallengeConfigService } from '../src/auth/challenge/services/authentication-challenge-config.service';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationDeliveryPolicyService } from '../src/auth/delivery/services/authentication-delivery-policy.service';
import { AuthenticationDeliveryBacklogRepository } from '../src/auth/delivery/repositories/authentication-delivery-backlog.repository';
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
import type { AuthenticationSignInRequestInput } from '../src/auth/challenge/types/authentication-challenge-request.type';

describe('SIGN_IN initial and replacement admission (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const identities = new Set<string>();
  const legacySubjects = new Set<string>();
  const ownedKeys = new Set<string>();
  const replicaName = `initial_admission_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let module: TestingModule;
  let prisma: PrismaService;
  let replica: PrismaService;
  let requests: AuthenticationChallengeRequestService;
  let replicaRequests: AuthenticationChallengeRequestService;
  let replicaAdmission: AuthenticationDeliveryAdmissionService;
  let factory: AuthenticationChallengeProofFactoryService;
  let challengeRepository: AuthenticationChallengeRequestRepository;
  let challengeConfig: AuthenticationChallengeConfigService;
  let derivation: RateLimitBucketKeyService;
  let gcra: GcraAdmissionRepository;
  let cooldown: AuthenticationDeliveryCooldownRepository;
  let rateConfig: AuthenticationRateLimitConfigService;
  let input: AuthenticationSignInRequestInput;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Initial tests require a dedicated test database.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    requests = module.get(AuthenticationChallengeRequestService);
    factory = module.get(AuthenticationChallengeProofFactoryService);
    challengeRepository = module.get(AuthenticationChallengeRequestRepository);
    challengeConfig = module.get(AuthenticationChallengeConfigService);
    replicaAdmission = new AuthenticationDeliveryAdmissionService(
      new AuthenticationDeliveryRepository(
        replica,
        module.get(AuthenticationDeliveryPolicyService),
      ),
      module.get(AuthenticationDeliveryRateLimitService),
      module.get(AuthenticationDeliveryPolicyService),
      module.get(AuthenticationDeliveryBacklogRepository),
    );
    replicaRequests = new AuthenticationChallengeRequestService(
      challengeRepository,
      challengeConfig,
      factory,
      replicaAdmission,
    );
    derivation = module.get(RateLimitBucketKeyService);
    gcra = module.get(GcraAdmissionRepository);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
    rateConfig = module.get(AuthenticationRateLimitConfigService);
  });

  beforeEach(() => {
    input = newInput();
  });
  afterEach(async () => {
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: { in: [...identities] } },
      select: { id: true, normalizedIdentity: true },
    });
    for (const challenge of challenges)
      keys(
        { ...input, normalizedIdentity: challenge.normalizedIdentity },
        challenge.id,
      );
    await prisma.authenticationChallenge.deleteMany({
      where: { normalizedIdentity: { in: [...identities] } },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: {
        OR: [
          { normalizedIdentity: { in: [...identities] } },
          { key: { in: [...legacySubjects] } },
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
    legacySubjects.clear();
    ownedKeys.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function newInput(
    identity = `initial-${randomUUID()}@example.edu`,
  ): AuthenticationSignInRequestInput {
    identities.add(identity);
    const result = {
      normalizedIdentity: identity,
      ipAddress: `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
      idempotencyKey: randomUUID(),
      templateProtocolVersion: 1,
    };
    keys(result);
    return result;
  }

  function keys(value = input, challengeId?: string) {
    const result = {
      identity: derivation
        .deriveKeys(policies.identityDeliveryCooldown, value.normalizedIdentity)
        .buckets.map((b) => b.key),
      emailGcra: derivation
        .deriveKeys(policies.deliveryIdentity, value.normalizedIdentity)
        .buckets.map((b) => b.key),
      ipGcra: derivation
        .deriveKeys(policies.deliveryIp, value.ipAddress)
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

  async function request(value = input, other = false) {
    keys(value);
    const result = await (other ? replica : prisma).$transaction(
      (tx) =>
        (other ? replicaRequests : requests).requestSignInInTransaction(
          tx,
          value,
        ),
      { timeout: 10_000 },
    );
    if (result.outcome === 'CREATED' || result.outcome === 'REUSED')
      keys(value, result.challenge.id);
    return result;
  }

  async function state(value = input) {
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: value.normalizedIdentity },
      orderBy: { id: 'asc' },
    });
    challenges.forEach((challenge) => keys(value, challenge.id));
    const all = [
      ...new Set([
        ...Object.values(keys(value)).flat(),
        ...challenges.flatMap(
          (challenge) => keys(value, challenge.id).challenge,
        ),
      ]),
    ];
    return {
      subjects: await prisma.authenticationChallengeSubject.findMany({
        where: {
          OR: [
            { normalizedIdentity: value.normalizedIdentity },
            {
              key: { in: challenges.map((challenge) => challenge.subjectKey) },
            },
          ],
        },
        orderBy: { key: 'asc' },
      }),
      challenges,
      deliveries: await prisma.authenticationChallengeDelivery.findMany({
        where: {
          challengeId: { in: challenges.map((challenge) => challenge.id) },
        },
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

  async function seedChallenge(
    options: { legacy?: boolean; expired?: boolean; identity?: string } = {},
  ) {
    const identity = options.identity ?? input.normalizedIdentity;
    identities.add(identity);
    const id = randomUUID(),
      subjectKey = `e2e:initial:legacy:${randomUUID()}`;
    legacySubjects.add(subjectKey);
    const proof = factory.generate({
      challengeId: id,
      normalizedIdentity: identity,
      purpose: 'SIGN_IN',
    });
    return prisma.authenticationChallenge.create({
      data: {
        id,
        subject: {
          create: {
            key: subjectKey,
            ...(options.legacy
              ? {}
              : { normalizedIdentity: identity, purpose: 'SIGN_IN' as const }),
          },
        },
        normalizedIdentity: identity,
        identityType: 'INSTITUTIONAL_EMAIL',
        purpose: 'SIGN_IN',
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
        expiresAt: new Date(Date.now() + (options.expired ? -1_000 : 600_000)),
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  it('creates one SIGN_IN, encrypted stable proof, INITIAL Delivery and exact charges without a user/session', async () => {
    const usersBefore = await prisma.user.count(),
      sessionsBefore = await prisma.session.count();
    const result = await request();
    if (result.outcome !== 'CREATED') throw new Error('Expected creation.');
    const after = await state();
    expect(after.subjects).toHaveLength(1);
    expect(after.challenges).toHaveLength(1);
    expect(after.deliveries).toHaveLength(1);
    expect(after.subjects[0]).toMatchObject({
      normalizedIdentity: input.normalizedIdentity,
      purpose: 'SIGN_IN',
    });
    expect(after.subjects[0].key).not.toContain(input.normalizedIdentity);
    const challenge = after.challenges[0];
    expect(challenge).toMatchObject({
      id: result.challenge.id,
      purpose: 'SIGN_IN',
      userId: null,
      boundSessionId: null,
      failedAttemptCount: 0,
      lockedAt: null,
      consumedAt: null,
    });
    expect(challenge.expiresAt.getTime() - challenge.createdAt.getTime()).toBe(
      challengeConfig.ttlSeconds * 1_000,
    );
    expect(
      challenge.retentionExpiresAt.getTime() - challenge.createdAt.getTime(),
    ).toBe(challengeConfig.retentionSeconds * 1_000);
    expect(challenge.encryptedProof).not.toBeNull();
    expect(challenge.otpHash).toHaveLength(32);
    expect(challenge.linkTokenHash).toHaveLength(32);
    expect(after.deliveries[0]).toMatchObject({
      origin: 'INITIAL',
      recipientSnapshot: input.normalizedIdentity,
      status: 'PENDING',
      retentionExpiresAt: challenge.retentionExpiresAt,
    });
    expect(after.cd).toHaveLength(
      keys(input, challenge.id).identity.length +
        keys(input, challenge.id).challenge.length,
    );
    for (const row of after.cd)
      expect(row.boundary).toBe(
        (result.operationNowMicros + 60_000_000n).toString(),
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
    expect(await prisma.user.count()).toBe(usersBefore);
    expect(await prisma.session.count()).toBe(sessionsBefore);
    expect(Object.keys(result).sort()).toEqual([
      'challenge',
      'delivery',
      'operationNowMicros',
      'outcome',
    ]);
    expect(Object.keys(result.challenge).sort()).toEqual(['expiresAt', 'id']);
  });

  it('reuses a live challenge without changing proof, TTL, attempts, deliveries or any rate/audit state', async () => {
    const first = await request();
    if (first.outcome !== 'CREATED') throw new Error('Expected creation.');
    await prisma.authenticationChallenge.update({
      where: { id: first.challenge.id },
      data: { failedAttemptCount: 3, expiresAt: new Date(Date.now() + 60_000) },
    });
    const before = await state();
    expect(
      await request({ ...input, idempotencyKey: randomUUID() }, true),
    ).toEqual({
      outcome: 'REUSED',
      challenge: {
        id: first.challenge.id,
        expiresAt: before.challenges[0].expiresAt,
      },
    });
    expect(await state()).toEqual(before);
  });

  it('finds a reusable legacy challenge without rewriting its subject or creating a Delivery', async () => {
    const old = await seedChallenge({ legacy: true });
    const before = await state();
    expect(await request()).toMatchObject({
      outcome: 'REUSED',
      challenge: { id: old.id },
    });
    const after = await state();
    expect(after.challenges).toEqual(before.challenges);
    expect(after.deliveries).toEqual([]);
    expect(after.cd).toEqual([]);
    expect(after.gcra).toEqual([]);
    expect(
      after.subjects.find((subject) => subject.key === old.subjectKey),
    ).toEqual(before.subjects[0]);
    expect(after.subjects).toHaveLength(2);
  });

  it('replaces an expired challenge with new proof while leaving the predecessor untouched', async () => {
    const old = await seedChallenge({ expired: true });
    const result = await request();
    if (result.outcome !== 'CREATED') throw new Error('Expected replacement.');
    expect(result.challenge.id).not.toBe(old.id);
    const after = await state();
    expect(after.challenges).toHaveLength(2);
    expect(
      after.challenges.find((challenge) => challenge.id === old.id),
    ).toEqual(old);
    const replacement = after.challenges.find(
      (challenge) => challenge.id === result.challenge.id,
    )!;
    expect(replacement.otpHash).not.toEqual(old.otpHash);
    expect(replacement.linkTokenHash).not.toEqual(old.linkTokenHash);
    expect(replacement.encryptedProof).not.toEqual(old.encryptedProof);
    expect(after.deliveries).toHaveLength(1);
    expect(after.deliveries[0]).toMatchObject({
      challengeId: replacement.id,
      origin: 'INITIAL',
    });
  });

  it('does not reset cooldown on expiry and leaves no replacement after a business denial even when the owner commits', async () => {
    const old = await seedChallenge({ expired: true });
    await prisma.$transaction((tx) =>
      cooldown.writeAliases(
        tx,
        keys().identity,
        BigInt(Date.now()) * 1_000n + 60_000_000n,
      ),
    );
    const before = await state();
    const marker = `e2e:initial:marker:${randomUUID()}`;
    legacySubjects.add(marker);
    await prisma.$transaction(async (tx) => {
      await tx.authenticationChallengeSubject.create({ data: { key: marker } });
      expect(
        await requests.requestSignInInTransaction(tx, input),
      ).toMatchObject({ outcome: 'RATE_LIMITED' });
    });
    expect(await state()).toEqual(before);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: marker },
      }),
    ).not.toBeNull();
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: old.id },
      }),
    ).toEqual(old);
  });

  it.each([
    { group: 'emailGcra' as const, replacement: false },
    { group: 'ipGcra' as const, replacement: false },
    { group: 'emailGcra' as const, replacement: true },
    { group: 'ipGcra' as const, replacement: true },
  ])(
    'preserves $group debt without partial creation (replacement=$replacement)',
    async ({ group, replacement }) => {
      if (replacement) await seedChallenge({ legacy: true, expired: true });
      const settings =
        group === 'emailGcra'
          ? rateConfig.deliveryIdentity
          : rateConfig.deliveryIp;
      const policy =
        group === 'emailGcra' ? policies.deliveryIdentity : policies.deliveryIp;
      const now = await gcra.operationNowMicros(prisma);
      let exhausted = chargeGcra(null, settings, now);
      for (let i = 1; i < settings.burst; i++)
        exhausted = chargeGcra(exhausted, settings, now);
      await prisma.$transaction((tx) =>
        gcra.writeAliases(tx, keys()[group], policy.id, exhausted),
      );
      const before = await state();
      expect(await request()).toMatchObject({
        outcome: 'RATE_LIMITED',
        deniedPolicyIds: [policy.id],
      });
      expect(await state()).toEqual(before);
    },
  );

  it('serializes first requests across independent clients into one challenge and one INITIAL charge', async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        request({ ...input, idempotencyKey: randomUUID() }, i % 2 === 1),
      ),
    );
    expect(
      results.filter((result) => result.outcome === 'CREATED'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'REUSED'),
    ).toHaveLength(15);
    const after = await state();
    expect(after.subjects).toHaveLength(1);
    expect(after.challenges).toHaveLength(1);
    expect(after.deliveries).toHaveLength(1);
    for (const result of results)
      expect(result).toMatchObject({
        challenge: { id: after.challenges[0].id },
      });
    const created = results.find((result) => result.outcome === 'CREATED')!;
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

  it('serializes competing replacements and rejects resend of the expired predecessor', async () => {
    const old = await seedChallenge({ expired: true });
    const [results, resend] = await Promise.all([
      Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          request({ ...input, idempotencyKey: randomUUID() }, i % 2 === 1),
        ),
      ),
      replica.$transaction((tx) =>
        replicaAdmission.admitResendInTransaction(tx, {
          challengeId: old.id,
          ipAddress: input.ipAddress,
          idempotencyKey: randomUUID(),
          templateProtocolVersion: 1,
          retentionExpiresAt: old.retentionExpiresAt,
        }),
      ),
    ]);
    expect(
      results.filter((result) => result.outcome === 'CREATED'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'REUSED'),
    ).toHaveLength(7);
    expect(resend).toEqual({ outcome: 'CHALLENGE_UNAVAILABLE' });
    expect((await state()).deliveries).toHaveLength(1);
    expect((await state()).challenges).toHaveLength(2);
  });

  it('concurrent repeated initial and resend resolve existing work without new charges', async () => {
    const created = await request();
    if (created.outcome !== 'CREATED') throw new Error('Expected creation.');
    const before = await state();
    const [initial, resend] = await Promise.all([
      request({ ...input, idempotencyKey: randomUUID() }),
      replica.$transaction((tx) =>
        replicaAdmission.admitResendInTransaction(tx, {
          challengeId: created.challenge.id,
          ipAddress: input.ipAddress,
          idempotencyKey: randomUUID(),
          templateProtocolVersion: 1,
          retentionExpiresAt: before.challenges[0].retentionExpiresAt,
        }),
      ),
    ]);
    expect(initial.outcome).toBe('REUSED');
    expect(resend).toMatchObject({
      outcome: 'EXISTING',
      delivery: { id: created.delivery.id },
    });
    expect(await state()).toEqual(before);
  });

  it('rolls back the entire new flow on a later owner failure', async () => {
    const before = await state();
    await expect(
      prisma.$transaction(async (tx) => {
        expect(
          (await requests.requestSignInInTransaction(tx, input)).outcome,
        ).toBe('CREATED');
        throw new Error('Owner failed.');
      }),
    ).rejects.toThrow('Owner failed.');
    expect(await state()).toEqual(before);
  });

  it('rolls back replacement and charges on actual INITIAL insertion failure while preserving earlier caller work', async () => {
    await seedChallenge({ expired: true });
    const otherInput = newInput();
    const other = await request(otherInput);
    if (other.outcome !== 'CREATED')
      throw new Error('Expected other creation.');
    const before = await state();
    const marker = `e2e:initial:marker:${randomUUID()}`;
    legacySubjects.add(marker);
    await prisma.$transaction(async (tx) => {
      await tx.authenticationChallengeSubject.create({ data: { key: marker } });
      await expect(
        requests.requestSignInInTransaction(tx, {
          ...input,
          idempotencyKey: other.delivery.idempotencyKey,
        }),
      ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    });
    expect(await state()).toEqual(before);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: marker },
      }),
    ).not.toBeNull();
  });

  it('fails closed on contradictory legacy live challenges without selecting or rewriting one', async () => {
    await seedChallenge({ legacy: true });
    await seedChallenge({ legacy: true });
    const before = await state();
    await expect(request()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(await state()).toEqual(before);
  });

  it('reuses live stable proof above the former failure threshold', async () => {
    const old = await seedChallenge();
    await prisma.authenticationChallenge.update({
      where: { id: old.id },
      data: { failedAttemptCount: 5 },
    });
    const before = await state();
    expect(await request()).toMatchObject({
      outcome: 'REUSED',
      challenge: { id: old.id },
    });
    expect(await state()).toEqual(before);
  });

  it('does not reopen a consumed challenge when starting another sign-in', async () => {
    const old = await seedChallenge();
    await prisma.authenticationChallenge.update({
      where: { id: old.id },
      data: {
        consumedAt: new Date(),
        encryptedProof: null,
        proofEncryptionIv: null,
        proofEncryptionTag: null,
      },
    });
    const before = await state();
    expect((await request()).outcome).toBe('CREATED');
    expect(
      (await state()).challenges.find((challenge) => challenge.id === old.id),
    ).toEqual(before.challenges[0]);
  });

  it.each([
    'AuthenticationChallengeSubject',
    'AuthenticationChallenge',
  ] as const)(
    'resolves expiry using fresh time after waiting on %s',
    async (table) => {
      const old = await seedChallenge();
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()+INTERVAL '0.8 seconds' WHERE "id"=${old.id}`;
      let ready!: () => void, release!: () => void;
      const readyPromise = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = prisma.$transaction(
        async (tx) => {
          if (table === 'AuthenticationChallengeSubject')
            await tx.$queryRaw`SELECT "key" FROM "AuthenticationChallengeSubject" WHERE "key"=${old.subjectKey} FOR UPDATE`;
          else
            await tx.$queryRaw`SELECT "id" FROM "AuthenticationChallenge" WHERE "id"=${old.id} FOR UPDATE`;
          ready();
          await releasePromise;
        },
        { timeout: 10_000 },
      );
      await readyPromise;
      const pending = request(input, true);
      try {
        await waitForReplicaLock();
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release();
        await holding;
        const result = await pending;
        expect(result.outcome).toBe('CREATED');
        if (result.outcome === 'CREATED')
          expect(result.challenge.id).not.toBe(old.id);
      } finally {
        release();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  async function waitForReplicaLock() {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Replica did not wait for the expected lock.');
  }

  it('rolls back a new challenge when its Delivery window closes during a bucket wait', async () => {
    const shorterConfig = {
      ttlSeconds: 121,
      retentionSeconds: challengeConfig.retentionSeconds,
    } as AuthenticationChallengeConfigService;
    const shortRequests = new AuthenticationChallengeRequestService(
      challengeRepository,
      shorterConfig,
      factory,
      replicaAdmission,
    );
    const before = await state();
    let ready!: () => void, release!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await gcra.lockAliases(tx, keys().identity);
        ready();
        await releasePromise;
      },
      { timeout: 10_000 },
    );
    await readyPromise;
    const pending = replica.$transaction(
      (tx) => shortRequests.requestSignInInTransaction(tx, input),
      { timeout: 10_000 },
    );
    try {
      await waitForReplicaLock();
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.2)`;
      release();
      await holding;
      expect(await pending).toEqual({ outcome: 'DELIVERY_WINDOW_CLOSED' });
      expect(await state()).toEqual(before);
    } finally {
      release();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('retries a DB-confirmed serialization abort only as a fresh whole-owner transaction', async () => {
    const captured = input;
    const schema = `initial_abort_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    if (!/^[a-f0-9-]{36}$/.test(captured.idempotencyKey))
      throw new Error('Unexpected test key.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_insert() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."idempotencyKey"=TG_ARGV[0] AND nextval('"${schema}".attempts')<=1 THEN RAISE EXCEPTION 'Injected initial abort.' USING ERRCODE='40001'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuthenticationChallengeDelivery" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_insert('${captured.idempotencyKey}')`,
      );
      let attempts = 0;
      let committed: Awaited<ReturnType<typeof request>> | undefined;
      while (attempts < 2) {
        attempts++;
        try {
          committed = await request(captured);
          break;
        } catch (error) {
          if (!isRetryableGcraTransactionError(error) || attempts === 2)
            throw error;
        }
      }
      expect(attempts).toBe(2);
      if (committed?.outcome !== 'CREATED') throw new Error('Expected commit.');
      const after = await state();
      expect(after.subjects).toHaveLength(1);
      expect(after.challenges).toHaveLength(1);
      expect(after.deliveries).toHaveLength(1);
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

  it('supports SERIALIZABLE ownership and rejects unsupported/root transaction scope', async () => {
    await expect(
      requests.requestSignInInTransaction(prisma, input),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      prisma.$transaction(
        (tx) => requests.requestSignInInTransaction(tx, input),
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(
      (
        await prisma.$transaction(
          (tx) => requests.requestSignInInTransaction(tx, input),
          { isolationLevel: 'Serializable' },
        )
      ).outcome,
    ).toBe('CREATED');
  });
});
