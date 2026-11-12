import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import {
  Prisma,
  type AuthenticationChallenge,
} from '../src/generated/prisma/client';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AccountDeletionFinalizationService } from '../src/account/services/account-deletion-finalization.service';
import { AccountDeletionNotificationService } from '../src/notifications/services/account-deletion-notification.service';
import { SecurityEventService } from '../src/security/services/security-event.service';
import { MailService } from '../src/mail/mail.service';
import { PasswordService } from '../src/auth/password/services/password.service';
import { AuthenticationChallengeCleanupRepository } from '../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationChallengeFinalizationRepository } from '../src/auth/challenge/repositories/authentication-challenge-finalization.repository';
import { AuthenticationChallengeCleanupService } from '../src/auth/challenge/services/authentication-challenge-cleanup.service';
import { AuthenticationChallengeRequestService } from '../src/auth/challenge/services/authentication-challenge-request.service';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryAdmissionService } from '../src/auth/delivery/services/authentication-delivery-admission.service';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import { AuthenticationEmailProviderPort } from '../src/auth/delivery/ports/authentication-email-provider.port';
import type {
  AuthenticationEmailProviderResult,
  AuthenticationEmailSubmission,
} from '../src/auth/delivery/types/authentication-email-provider.type';
import { AuthenticationOperationService } from '../src/auth/operations/services/authentication-operation.service';
import { AuthenticationOperationRepository } from '../src/auth/operations/repositories/authentication-operation.repository';
import type { AuthenticationOperationRequest } from '../src/auth/operations/types/authentication-operation.type';
import { AuthenticationDeliveryCooldownRepository } from '../src/auth/rate-limit/repositories/authentication-delivery-cooldown.repository';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import { chargeGcra } from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';

describe('Delivery admission, retention and account finalization (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const identities = new Set<string>(),
    userIds = new Set<string>(),
    subjectKeys = new Set<string>(),
    operationIds = new Set<string>(),
    ownedKeys = new Set<string>();
  const replicaName = `admission_lifecycle_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const mail = {
    sendAccountDeletedEmail: jest
      .fn()
      .mockResolvedValue('test-deletion-message'),
  };
  const provider = {
    submit: jest
      .fn<
        Promise<AuthenticationEmailProviderResult>,
        [AuthenticationEmailSubmission]
      >()
      .mockResolvedValue({ outcome: 'ACCEPTED' }),
  };
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  let operations: AuthenticationOperationService,
    replicaOperations: AuthenticationOperationService;
  let cleanup: AuthenticationChallengeCleanupRepository,
    cleanupService: AuthenticationChallengeCleanupService;
  let finalization: AccountDeletionFinalizationService,
    replicaFinalization: AccountDeletionFinalizationService;
  let proofFactory: AuthenticationChallengeProofFactoryService;
  let derivation: RateLimitBucketKeyService,
    cooldown: AuthenticationDeliveryCooldownRepository,
    rateConfig: AuthenticationRateLimitConfigService;
  let input: AuthenticationOperationRequest & { kind: 'SIGN_IN_REQUEST' };
  let universityId: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailService)
      .useValue(mail)
      .overrideProvider(AuthenticationEmailProviderPort)
      .useValue(provider)
      .compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Lifecycle tests require a dedicated test database.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    operations = module.get(AuthenticationOperationService);
    replicaOperations = operationOwner(replica);
    cleanup = module.get(AuthenticationChallengeCleanupRepository);
    cleanupService = module.get(AuthenticationChallengeCleanupService);
    finalization = module.get(AccountDeletionFinalizationService);
    replicaFinalization = finalizer(replica);
    proofFactory = module.get(AuthenticationChallengeProofFactoryService);
    derivation = module.get(RateLimitBucketKeyService);
    cooldown = module.get(AuthenticationDeliveryCooldownRepository);
    rateConfig = module.get(AuthenticationRateLimitConfigService);
    universityId = (
      await prisma.university.create({
        data: { name: `Lifecycle University ${randomUUID()}` },
      })
    ).id;
  });

  function finalizer(client: PrismaService) {
    return new AccountDeletionFinalizationService(
      client,
      module.get(PasswordService),
      module.get(SecurityEventService),
      module.get(AccountDeletionNotificationService),
      module.get(ConfigService),
      module.get(AuthenticationChallengeFinalizationRepository),
    );
  }
  function operationOwner(client: PrismaService) {
    return new AuthenticationOperationService(
      client,
      module.get(AuthenticationOperationRepository),
      module.get(AuthenticationChallengeRequestService),
      module.get(AuthenticationDeliveryAdmissionService),
      module.get(GcraAdmissionConfigService),
    );
  }
  beforeEach(() => {
    mail.sendAccountDeletedEmail.mockClear();
    provider.submit.mockClear();
    const identity = `lifecycle-${randomUUID()}@example.edu`;
    identities.add(identity);
    input = {
      kind: 'SIGN_IN_REQUEST',
      input: {
        normalizedIdentity: identity,
        ipAddress: `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
        templateProtocolVersion: 1,
      },
    };
    keys();
  });
  afterEach(async () => {
    await state();
    await prisma.authenticationOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.authenticationChallenge.deleteMany({
      where: {
        OR: [
          { normalizedIdentity: { in: [...identities] } },
          { userId: { in: [...userIds] } },
        ],
      },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: {
        OR: [
          { normalizedIdentity: { in: [...identities] } },
          { key: { in: [...subjectKeys] } },
        ],
      },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.notificationDelivery.deleteMany({
      where: { userId: { in: [...userIds] } },
    });
    await prisma.securityEvent.deleteMany({
      where: { userId: { in: [...userIds] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
    identities.clear();
    userIds.clear();
    subjectKeys.clear();
    operationIds.clear();
    ownedKeys.clear();
  });
  afterAll(async () => {
    await prisma.university.delete({ where: { id: universityId } });
    await replica.$disconnect();
    await module.close();
  });

  function keys(
    challengeId?: string,
    identity = input.input.normalizedIdentity,
  ) {
    const result = {
      identity: derivation
        .deriveKeys(policies.identityDeliveryCooldown, identity)
        .buckets.map((b) => b.key),
      email: derivation
        .deriveKeys(policies.deliveryIdentity, identity)
        .buckets.map((b) => b.key),
      ip: derivation
        .deriveKeys(policies.deliveryIp, input.input.ipAddress)
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
  async function mint() {
    const id = await operations.createOperationId();
    operationIds.add(id);
    return id;
  }
  async function subject(
    identity = input.input.normalizedIdentity,
    identified = true,
  ) {
    identities.add(identity);
    const key = randomUUID();
    subjectKeys.add(key);
    return prisma.authenticationChallengeSubject.create({
      data: {
        key,
        ...(identified
          ? { normalizedIdentity: identity, purpose: 'SIGN_IN' }
          : {}),
      },
    });
  }
  async function seedChallenge(
    options: {
      subjectKey?: string;
      identity?: string;
      userId?: string;
      expired?: boolean;
      retained?: boolean;
      purpose?: 'SIGN_IN' | 'STEP_UP';
      boundSessionId?: string;
    } = {},
  ) {
    const identity = options.identity ?? input.input.normalizedIdentity;
    identities.add(identity);
    const subjectKey =
      options.subjectKey ?? (await subject(identity, false)).key;
    const purpose = options.purpose ?? 'SIGN_IN';
    const id = randomUUID(),
      proof = proofFactory.generate({
        challengeId: id,
        normalizedIdentity: identity,
        purpose,
      });
    keys(id, identity);
    return prisma.authenticationChallenge.create({
      data: {
        id,
        subjectKey,
        normalizedIdentity: identity,
        purpose,
        boundSessionId: options.boundSessionId,
        identityType: 'INSTITUTIONAL_EMAIL',
        userId: options.userId ?? null,
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
        expiresAt: new Date(Date.now() + (options.expired ? -1000 : 600_000)),
        retentionExpiresAt: new Date(
          Date.now() + (options.retained ? -1 : 86_400_000),
        ),
      },
    });
  }
  async function createUser(
    identity = input.input.normalizedIdentity,
    deleting = true,
  ) {
    identities.add(identity);
    const user = await prisma.user.create({
      data: {
        email: identity,
        username: `lifecycle-${randomUUID()}`,
        passwordHash: 'fixture-password-hash',
        universityId,
        status: deleting ? 'DELETION_SCHEDULED' : 'ACTIVE',
        ...(deleting
          ? {
              deletionRequestedAt: new Date(Date.now() - 60_000),
              deletionScheduledAt: new Date(Date.now() - 1000),
            }
          : {}),
      },
    });
    userIds.add(user.id);
    return user;
  }
  async function state() {
    const challenges = await prisma.authenticationChallenge.findMany({
      where: { normalizedIdentity: { in: [...identities] } },
      orderBy: { id: 'asc' },
    });
    challenges.forEach((challenge) =>
      keys(challenge.id, challenge.normalizedIdentity),
    );
    return {
      challenges,
      subjects: await prisma.authenticationChallengeSubject.findMany({
        where: {
          OR: [
            { normalizedIdentity: { in: [...identities] } },
            { key: { in: [...subjectKeys] } },
          ],
        },
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
      >(
        Prisma.sql`SELECT "key", "windowEndAt"::text AS boundary, "updatedAt"::text AS updated FROM "AuthenticationRateLimit" WHERE "key" IN (${Prisma.join([...ownedKeys])}) ORDER BY "key"`,
      ),
      gcra: await prisma.gcraRateLimit.findMany({
        where: { key: { in: [...ownedKeys] } },
        orderBy: { key: 'asc' },
      }),
    };
  }
  function resendInput(
    challenge: AuthenticationChallenge,
  ): AuthenticationOperationRequest {
    return {
      kind: 'RESEND',
      input: {
        challengeId: challenge.id,
        ipAddress: input.input.ipAddress,
        templateProtocolVersion: 1,
        retentionExpiresAt: challenge.retentionExpiresAt,
      },
    };
  }
  async function allowInterval(challengeId: string) {
    const aliases = keys(challengeId),
      now = await module.get(AuthenticationOperationRepository).nowMicros();
    // Historical cooldown fixture only: the GCRA debt is deliberately preserved.
    await prisma.$transaction((tx) =>
      cooldown.writeAliases(
        tx,
        [...aliases.identity, ...aliases.challenge],
        now - 1n,
      ),
    );
  }

  it('integrates initial/reuse/resend/provider/replacement/retention/replay while preserving proof and exact debt', async () => {
    const initialId = await mint(),
      initial = await operations.execute(initialId, input);
    if (initial.result.outcome !== 'CREATED')
      throw new Error('Expected creation.');
    const original = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: initial.result.challengeId },
    });
    keys(original.id);
    const charged = [initial.result.admissionNowMicros];
    const beforeReuse = await state();
    expect((await operations.execute(await mint(), input)).result.outcome).toBe(
      'REUSED',
    );
    expect(
      (await operations.execute(await mint(), resendInput(original))).result
        .outcome,
    ).toBe('EXISTING');
    expect(await operations.execute(initialId, input)).toEqual({
      ...initial,
      replayed: true,
    });
    const afterReuse = await state();
    expect(afterReuse.challenges).toEqual(beforeReuse.challenges);
    expect(afterReuse.deliveries).toEqual(beforeReuse.deliveries);
    expect(afterReuse.cd).toEqual(beforeReuse.cd);
    expect(afterReuse.gcra).toEqual(beforeReuse.gcra);
    const repository = module.get(AuthenticationDeliveryRepository),
      orchestration = module.get(AuthenticationDeliveryOrchestrationService);
    const firstClaim = await repository.claimNextDelivery();
    if (!firstClaim) throw new Error('Expected claim.');
    expect(await orchestration.process(firstClaim)).toEqual({
      outcome: 'SENT',
    });
    await allowInterval(original.id);
    const resendId = await mint(),
      resend = await operations.execute(resendId, resendInput(original));
    if (resend.result.outcome !== 'CREATED')
      throw new Error('Expected resend.');
    charged.push(resend.result.admissionNowMicros);
    const secondClaim = await repository.claimNextDelivery();
    if (!secondClaim) throw new Error('Expected second claim.');
    expect(await orchestration.process(secondClaim)).toEqual({
      outcome: 'SENT',
    });
    expect(provider.submit).toHaveBeenCalledTimes(2);
    const firstSubmission = provider.submit.mock.calls[0][0],
      secondSubmission = provider.submit.mock.calls[1][0];
    expect(secondSubmission.content).toEqual(firstSubmission.content);
    expect(secondSubmission.idempotencyKey).not.toBe(
      firstSubmission.idempotencyKey,
    );
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: original.id },
      }),
    ).toEqual(original);
    // Expired historical fixture; no production clock, service or limiter is mocked.
    await prisma.authenticationChallenge.update({
      where: { id: original.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const beforeDenied = await state();
    expect(
      (await operations.execute(await mint(), input)).result,
    ).toMatchObject({ outcome: 'DENIED', denial: 'RATE_LIMITED' });
    expect((await state()).challenges).toEqual(beforeDenied.challenges);
    await allowInterval(original.id);
    const replacement = await operations.execute(await mint(), input);
    if (replacement.result.outcome !== 'CREATED')
      throw new Error('Expected replacement.');
    charged.push(replacement.result.admissionNowMicros);
    expect(replacement.result.challengeId).not.toBe(original.id);
    keys(replacement.result.challengeId);
    const afterReplacement = await state();
    for (const row of afterReplacement.gcra) {
      const policy =
        row.policyId === policies.deliveryIdentity.id
          ? rateConfig.deliveryIdentity
          : rateConfig.deliveryIp;
      let expected = chargeGcra(null, policy, charged[0]);
      for (const at of charged.slice(1))
        expected = chargeGcra(expected, policy, at);
      expect(fromGcraPersistenceData(row)).toEqual(expected);
    }
    // Retention is DB-authoritative; an application-clock deadline one
    // millisecond in the past is not guaranteed to precede the DB clock.
    await prisma.$executeRaw`
      UPDATE "AuthenticationChallenge"
      SET "retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second'
      WHERE "id"=${original.id}
    `;
    expect(await cleanup.deleteOneRetainedChallengeBatch(100)).toBe(1);
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(0);
    expect(await operations.execute(resendId, resendInput(original))).toEqual({
      ...resend,
      replayed: true,
    });
    await prisma.$executeRaw`
      UPDATE "AuthenticationChallenge"
      SET "expiresAt"=clock_timestamp()-INTERVAL '2 seconds',
          "retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second'
      WHERE "id"=${replacement.result.challengeId}
    `;
    const preserved = await state();
    expect(await cleanup.deleteOneRetainedChallengeBatch(100)).toBe(1);
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(1);
    const afterCleanup = await state();
    expect(afterCleanup.subjects).toHaveLength(0);
    expect(afterCleanup.challenges).toHaveLength(0);
    expect(afterCleanup.deliveries).toHaveLength(0);
    expect(afterCleanup.cd).toEqual(preserved.cd);
    expect(afterCleanup.gcra).toEqual(preserved.gcra);
    expect(afterCleanup.receipts).toEqual(preserved.receipts);
    expect(await operations.execute(initialId, input)).toEqual({
      ...initial,
      replayed: true,
    });
    expect(
      (await operations.execute(await mint(), input)).result,
    ).toMatchObject({ outcome: 'DENIED', denial: 'RATE_LIMITED' });
    expect((await state()).subjects).toHaveLength(0);
  });

  it('retains identified coordination while a legacy or retained challenge exists', async () => {
    const canonical = await subject();
    const legacy = await seedChallenge({ expired: true });
    const before = await state();
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(0);
    expect(await state()).toEqual(before);
    await prisma.authenticationChallenge.delete({ where: { id: legacy.id } });
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(1);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: canonical.key },
      }),
    ).toBeNull();
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: legacy.subjectKey },
      }),
    ).not.toBeNull();
  });

  it('does not cascade a linked challenge whose identity differs from subject metadata', async () => {
    const canonical = await subject();
    const other = `linked-${randomUUID()}@example.edu`;
    const challenge = await seedChallenge({
      subjectKey: canonical.key,
      identity: other,
    });
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(0);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: challenge.id },
      }),
    ).toEqual(challenge);
  });

  it('runs all retention phases under the shared budget and removes newly orphaned identified subjects', async () => {
    const canonical = await subject();
    await seedChallenge({
      subjectKey: canonical.key,
      expired: true,
      retained: true,
    });
    expect(await cleanupService.runOnce()).toMatchObject({
      clearedExpiredProofCount: 1,
      deletedRetainedChallengeCount: 1,
      deletedOrphanedSubjectCount: 1,
    });
    expect((await state()).subjects).toHaveLength(0);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function waitForReplicaLock() {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.$queryRaw<
        { query: string }[]
      >`SELECT query FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
      if (rows.length) return rows[0].query;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Replica did not wait for the expected lock.');
  }

  it('skips locked orphan subjects and deletes them after release', async () => {
    const orphan = await subject(),
      ready = deferred<void>(),
      release = deferred<void>();
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "key" FROM "AuthenticationChallengeSubject" WHERE "key"=${orphan.key} FOR UPDATE`;
        ready.resolve();
        await release.promise;
      },
      { timeout: 10_000 },
    );
    await ready.promise;
    try {
      expect(await cleanup.deleteOneOrphanedSubjectBatch(10)).toBe(0);
    } finally {
      release.resolve();
      await holding;
    }
    expect(await cleanup.deleteOneOrphanedSubjectBatch(10)).toBe(1);
  });

  it('recovers an actual subject deletion between conflict resolution and row locking', async () => {
    const orphan = await subject(),
      ready = deferred<Prisma.TransactionClient>(),
      release = deferred<void>();
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "key" FROM "AuthenticationChallengeSubject" WHERE "key"=${orphan.key} FOR UPDATE`;
        ready.resolve(tx);
        await release.promise;
      },
      { timeout: 10_000 },
    );
    const control = await ready.promise;
    const pending = replicaOperations.execute(await mint(), input);
    try {
      const waiting = await waitForReplicaLock();
      expect(waiting).toContain('SELECT "key"');
      await control.authenticationChallengeSubject.delete({
        where: { key: orphan.key },
      });
      release.resolve();
      await holding;
      expect((await pending).result.outcome).toBe('CREATED');
      const after = await state();
      expect(after.subjects).toHaveLength(1);
      expect(after.subjects[0].key).not.toBe(orphan.key);
      expect(after.challenges).toHaveLength(1);
    } finally {
      release.resolve();
      await Promise.allSettled([holding, pending]);
    }
  });

  it('races orphan cleanup with initial requests without losing active work or duplicating challenges', async () => {
    await subject();
    const id = await mint();
    const [first] = await Promise.all([
      replicaOperations.execute(id, input),
      cleanup.deleteOneOrphanedSubjectBatch(100),
    ]);
    expect(first.result.outcome).toBe('CREATED');
    const before = await state();
    expect(await cleanup.deleteOneOrphanedSubjectBatch(100)).toBe(0);
    expect(await state()).toEqual(before);
    expect(before.subjects).toHaveLength(1);
    expect(before.challenges).toHaveLength(1);
    expect(before.deliveries).toHaveLength(1);
  });

  it('rechecks newly committed legacy references after taking subject locks', async () => {
    const canonical = await subject(),
      legacy = await subject(input.input.normalizedIdentity, false);
    const ready = deferred<void>(),
      release = deferred<void>();
    type Query = (
      query: Prisma.Sql | TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<unknown>;
    const paused = new AuthenticationChallengeCleanupRepository({
      $transaction: (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        prisma.$transaction(async (tx) => {
          let calls = 0;
          const execute = tx.$queryRaw.bind(tx) as Query;
          const proxy = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== '$queryRaw') {
                const value: unknown = Reflect.get(target, property, receiver);
                return value;
              }
              return async (
                query: Prisma.Sql | TemplateStringsArray,
                ...values: unknown[]
              ) => {
                const rows = await execute(query, ...values);
                if (++calls === 1) {
                  ready.resolve();
                  await release.promise;
                }
                return rows;
              };
            },
          });
          return callback(proxy);
        }, options),
    } as unknown as PrismaService);
    // Pause only after the real candidate query; its subject locks remain held.
    const pending = paused.deleteOneOrphanedSubjectBatch(100);
    await ready.promise;
    try {
      const challenge = await seedChallenge({ subjectKey: legacy.key });
      release.resolve();
      expect(await pending).toBe(0);
      expect(
        await prisma.authenticationChallengeSubject.findUnique({
          where: { key: canonical.key },
        }),
      ).not.toBeNull();
      expect(
        await prisma.authenticationChallenge.findUnique({
          where: { id: challenge.id },
        }),
      ).toEqual(challenge);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it('bounds orphan batches and leaves anonymous legacy subjects intact', async () => {
    await subject();
    await subject(`orphan-${randomUUID()}@example.edu`);
    await subject(`orphan-${randomUUID()}@example.edu`);
    const legacy = await subject(input.input.normalizedIdentity, false);
    expect(await cleanup.deleteOneOrphanedSubjectBatch(2)).toBe(2);
    expect(await cleanup.deleteOneOrphanedSubjectBatch(2)).toBe(1);
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: legacy.key },
      }),
    ).not.toBeNull();
  });

  it('returns 54 remaining seconds from a historical 00:06 resend check without moving its boundaries', async () => {
    const initial = await operations.execute(await mint(), input);
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
      boundary =
        (await module.get(AuthenticationOperationRepository).nowMicros()) +
        54_000_000n;
    await prisma.$transaction((tx) =>
      cooldown.writeAliases(
        tx,
        [...aliases.identity, ...aliases.challenge],
        boundary,
      ),
    );
    const before = await state();
    expect(
      (await operations.execute(await mint(), resendInput(challenge))).result,
    ).toMatchObject({
      outcome: 'DENIED',
      denial: 'RATE_LIMITED',
      remainingWaitSeconds: 54n,
      retryNotBeforeMicros: boundary,
    });
    const after = await state();
    expect(after.cd).toEqual(before.cd);
    expect(after.gcra).toEqual(before.gcra);
    expect(after.challenges).toEqual(before.challenges);
    expect(after.deliveries).toEqual(before.deliveries);
  });

  it('finalizes unbound SIGN_IN and owned challenges/subjects while preserving receipts and all limiter debt', async () => {
    const user = await createUser();
    const id = await mint(),
      initial = await operations.execute(id, input);
    if (initial.result.outcome !== 'CREATED')
      throw new Error('Expected initial.');
    const bound = await seedChallenge({ userId: user.id });
    const before = await state();
    expect(await finalization.finalizeBatch()).toBe(1);
    const after = await state();
    expect(after.challenges).toHaveLength(0);
    expect(after.deliveries).toHaveLength(0);
    expect(
      after.subjects.filter((row) => row.normalizedIdentity !== null),
    ).toHaveLength(0);
    expect(after.cd).toEqual(before.cd);
    expect(after.gcra).toEqual(before.gcra);
    expect(after.receipts).toEqual(before.receipts);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: bound.id },
      }),
    ).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({
      status: 'DELETED',
      email: `deleted+${user.id}@deleted.invalid`,
    });
    expect(mail.sendAccountDeletedEmail).toHaveBeenCalledTimes(1);
    expect(await operations.execute(id, input)).toEqual({
      ...initial,
      replayed: true,
    });
  });

  it("does not remove a different user's bound challenge even when its identity matches the deleted account", async () => {
    await createUser();
    const other = await createUser(`other-${randomUUID()}@example.edu`, false);
    const canonical = await subject();
    const foreign = await seedChallenge({
      subjectKey: canonical.key,
      userId: other.id,
    });
    const unbound = await seedChallenge({ subjectKey: canonical.key });
    expect(await finalization.finalizeBatch()).toBe(1);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: foreign.id },
      }),
    ).toEqual(foreign);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: unbound.id },
      }),
    ).toBeNull();
    expect(
      await prisma.authenticationChallengeSubject.findUnique({
        where: { key: canonical.key },
      }),
    ).not.toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: other.id } }),
    ).toMatchObject({ status: 'ACTIVE' });
  });

  it('deletes an owned session-bound STEP_UP before Session removal can violate the purpose binding constraint', async () => {
    const user = await createUser();
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        hashedRefreshToken: 'fixture-refresh-hash',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const challenge = await seedChallenge({
      userId: user.id,
      purpose: 'STEP_UP',
      boundSessionId: session.id,
    });
    expect(await finalization.finalizeBatch()).toBe(1);
    expect(
      await prisma.authenticationChallenge.findUnique({
        where: { id: challenge.id },
      }),
    ).toBeNull();
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ status: 'DELETED' });
  });

  it('rolls back subject/challenge deletion when account terminalization fails later', async () => {
    const user = await createUser();
    await operations.execute(await mint(), input);
    const before = await state();
    const schema = `finalization_fault_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_update() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."status"='DELETED' AND NEW."id"=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected finalization failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`,
      );
      if (!/^[a-z0-9]+$/.test(user.id))
        throw new Error('Unexpected fixture user ID.');
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_update('${user.id}')`,
      );
      await expect(finalization.finalizeBatch()).rejects.toThrow();
      expect(await state()).toEqual(before);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toMatchObject({ status: 'DELETION_SCHEDULED' });
      expect(
        await prisma.securityEvent.count({
          where: { userId: user.id, type: 'ACCOUNT_DELETED' },
        }),
      ).toBe(0);
      expect(mail.sendAccountDeletedEmail).not.toHaveBeenCalled();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "User"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('serializes finalization after an in-flight initial commit and retains its receipt', async () => {
    const user = await createUser(),
      ready = deferred<void>(),
      release = deferred<void>();
    // Real transaction boundary wrapper: pause after actual domain/receipt SQL,
    // before COMMIT. No repository or admission implementation is replaced.
    const paused = operationOwner({
      $transaction: (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        prisma.$transaction(async (tx) => {
          const result = await callback(tx);
          ready.resolve();
          await release.promise;
          return result;
        }, options),
    } as unknown as PrismaService);
    const id = await mint(),
      pendingInitial = paused.execute(id, input);
    await ready.promise;
    const pendingFinalization = replicaFinalization.finalizeBatch();
    try {
      await waitForReplicaLock();
      release.resolve();
      const initial = await pendingInitial;
      expect(await pendingFinalization).toBe(1);
      const after = await state();
      expect(after.challenges).toHaveLength(0);
      expect(after.receipts).toHaveLength(1);
      expect(after.cd.length).toBeGreaterThan(0);
      expect(await operations.execute(id, input)).toEqual({
        ...initial,
        replayed: true,
      });
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toMatchObject({ status: 'DELETED' });
    } finally {
      release.resolve();
      await Promise.allSettled([pendingInitial, pendingFinalization]);
    }
  });

  it('preserves active limiter debt when an initial request waits for finalization to commit', async () => {
    const user = await createUser();
    await operations.execute(await mint(), input);
    const before = await state();
    const ready = deferred<void>(),
      release = deferred<void>();
    const paused = finalizer({
      $transaction: (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options: object,
      ) =>
        prisma.$transaction(async (tx) => {
          const result = await callback(tx);
          if (result !== null) {
            ready.resolve();
            await release.promise;
          }
          return result;
        }, options),
    } as unknown as PrismaService);
    const pendingFinalization = paused.finalizeBatch();
    await ready.promise;
    const pendingInitial = replicaOperations.execute(await mint(), input);
    try {
      await waitForReplicaLock();
      release.resolve();
      expect(await pendingFinalization).toBe(1);
      expect((await pendingInitial).result).toMatchObject({
        outcome: 'DENIED',
        denial: 'RATE_LIMITED',
      });
      const after = await state();
      expect(after.challenges).toHaveLength(0);
      expect(
        after.subjects.filter((row) => row.normalizedIdentity !== null),
      ).toHaveLength(0);
      expect(after.cd).toEqual(before.cd);
      expect(after.gcra).toEqual(before.gcra);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toMatchObject({ status: 'DELETED' });
    } finally {
      release.resolve();
      await Promise.allSettled([pendingFinalization, pendingInitial]);
    }
  });

  it('admits fifty INITIAL and fifty interval-eligible RESEND Deliveries sharing one IP without resetting debt', async () => {
    const campus: (AuthenticationOperationRequest & {
      kind: 'SIGN_IN_REQUEST';
    })[] = Array.from({ length: 50 }, () => {
      const identity = `campus-${randomUUID()}@example.edu`;
      identities.add(identity);
      keys(undefined, identity);
      return {
        kind: 'SIGN_IN_REQUEST',
        input: { ...input.input, normalizedIdentity: identity },
      };
    });
    const initialIds = await Promise.all(campus.map(() => mint()));
    const first = await Promise.all(
      campus.map((value, index) =>
        (index % 2 ? replicaOperations : operations).execute(
          initialIds[index],
          value,
        ),
      ),
    );
    expect(
      first.every((response) => response.result.outcome === 'CREATED'),
    ).toBe(true);
    const before = await state();
    expect(before.challenges).toHaveLength(50);
    expect(before.deliveries).toHaveLength(50);
    const boundary = await module
      .get(AuthenticationOperationRepository)
      .nowMicros();
    await prisma.$transaction(
      async (tx) => {
        await tx.authenticationChallengeDelivery.updateMany({
          where: {
            challengeId: {
              in: before.challenges.map((challenge) => challenge.id),
            },
          },
          data: { status: 'SENT', sentAt: new Date() },
        });
        // Historical minimum-interval eligibility; keep every GCRA state untouched.
        for (const challenge of before.challenges) {
          const aliases = keys(challenge.id, challenge.normalizedIdentity);
          await cooldown.writeAliases(
            tx,
            [...aliases.identity, ...aliases.challenge],
            boundary - 1n,
          );
        }
      },
      { timeout: 10_000 },
    );
    const resendIds = await Promise.all(before.challenges.map(() => mint()));
    const second = await Promise.all(
      before.challenges.map((challenge, index) =>
        (index % 2 ? replicaOperations : operations).execute(
          resendIds[index],
          resendInput(challenge),
        ),
      ),
    );
    expect(
      second.every((response) => response.result.outcome === 'CREATED'),
    ).toBe(true);
    const after = await state();
    expect(after.challenges).toHaveLength(50);
    expect(after.deliveries).toHaveLength(100);
    expect(after.receipts).toHaveLength(100);
    const times = [...first, ...second]
      .map((response) => {
        if (response.result.outcome !== 'CREATED')
          throw new Error('Expected creation.');
        return response.result.admissionNowMicros;
      })
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    let expected = chargeGcra(null, rateConfig.deliveryIp, times[0]);
    for (const at of times.slice(1))
      expected = chargeGcra(expected, rateConfig.deliveryIp, at);
    const rows = after.gcra.filter(
      (row) => row.policyId === policies.deliveryIp.id,
    );
    expect(rows).toHaveLength(keys().ip.length);
    for (const row of rows)
      expect(fromGcraPersistenceData(row)).toEqual(expected);
  });
});
