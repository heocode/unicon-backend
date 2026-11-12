import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import type { AuthenticationChallenge } from '../src/generated/prisma/client';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionService } from '../src/rate-limit/services/gcra-admission.service';
import { RateLimitBucketKeyService } from '../src/rate-limit/services/rate-limit-bucket-key.service';
import {
  chargeGcra,
  createGcraState,
} from '../src/rate-limit/utils/gcra-state.util';
import { fromGcraPersistenceData } from '../src/rate-limit/utils/gcra-state-persistence.util';
import { isRetryableGcraTransactionError } from '../src/rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { AuthenticationRateLimitConfigService } from '../src/auth/rate-limit/services/authentication-rate-limit-config.service';
import { AuthenticationVerificationRateLimitService } from '../src/auth/rate-limit/services/authentication-verification-rate-limit.service';
import {
  AuthenticationVerificationProofOutcome as Outcome,
  type AuthenticationVerificationProofOutcome,
  type AuthenticationVerificationRateLimitInput,
} from '../src/auth/rate-limit/types/authentication-verification-rate-limit.type';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationChallengeProofService } from '../src/auth/challenge/services/authentication-challenge-proof.service';

describe('Conditional verification GCRA core (PostgreSQL)', () => {
  jest.setTimeout(20_000);
  const ownedKeys = new Set<string>(),
    subjects = new Set<string>();
  const replicaName = `verification_core_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  let service: AuthenticationVerificationRateLimitService,
    replicaService: AuthenticationVerificationRateLimitService;
  let repository: GcraAdmissionRepository,
    config: AuthenticationRateLimitConfigService,
    derivation: RateLimitBucketKeyService;
  let input: AuthenticationVerificationRateLimitInput;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Verification tests require a dedicated test database.');
    url.searchParams.set('application_name', replicaName);
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    config = module.get(AuthenticationRateLimitConfigService);
    repository = module.get(GcraAdmissionRepository);
    const ring = new Map([
      [1, Buffer.alloc(32, 4)],
      [2, Buffer.alloc(32, 5)],
    ]);
    derivation = new RateLimitBucketKeyService(
      new ConfigService({
        RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 2,
        RATE_LIMIT_HMAC_KEYS: ring,
      }),
    );
    const oldActive = new RateLimitBucketKeyService(
      new ConfigService({
        RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 1,
        RATE_LIMIT_HMAC_KEYS: ring,
      }),
    );
    service = new AuthenticationVerificationRateLimitService(
      config,
      derivation,
      repository,
    );
    replicaService = new AuthenticationVerificationRateLimitService(
      config,
      oldActive,
      repository,
    );
  });
  beforeEach(() => {
    input = context();
  });
  afterEach(async () => {
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...ownedKeys] } },
    });
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { in: [...subjects] } },
    });
    ownedKeys.clear();
    subjects.clear();
  });
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
  });

  function context(
    overrides: Partial<AuthenticationVerificationRateLimitInput> = {},
  ): AuthenticationVerificationRateLimitInput {
    const value = {
      normalizedIdentity: `verification-${randomUUID()}@example.edu`,
      ipAddress: `2001:db8:${randomUUID().slice(0, 4)}:${randomUUID().slice(0, 4)}::1`,
      expiresAtMicros: BigInt(Date.now() + 600_000) * 1000n,
      ...overrides,
    };
    groups(value);
    return value;
  }
  function groups(value = input) {
    const result = [
      {
        policy: policies.verificationIdentityShortTerm,
        settings: config.verificationIdentityShortTerm,
        value: value.normalizedIdentity,
      },
      {
        policy: policies.verificationIpShortTerm,
        settings: config.verificationIpShortTerm,
        value: value.ipAddress,
      },
      {
        policy: policies.verificationIdentityLongTerm,
        settings: config.verificationIdentityLongTerm,
        value: value.normalizedIdentity,
      },
      {
        policy: policies.verificationIpLongTerm,
        settings: config.verificationIpLongTerm,
        value: value.ipAddress,
      },
    ].map((item) => ({
      ...item,
      keys: derivation
        .deriveKeys(item.policy, item.value)
        .buckets.map((bucket) => bucket.key),
    }));
    result.flatMap((item) => item.keys).forEach((key) => ownedKeys.add(key));
    return result;
  }
  async function evaluate(
    value = input,
    outcome: AuthenticationVerificationProofOutcome = Outcome.CANONICAL_MISMATCH,
    other = false,
  ) {
    groups(value);
    return (other ? replica : prisma).$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true)`;
        return (other ? replicaService : service).evaluateInTransaction(
          tx,
          value,
          () => Promise.resolve(outcome),
        );
      },
      { timeout: 10_000, maxWait: 5_000 },
    );
  }
  function snapshot(value = input) {
    return prisma.gcraRateLimit.findMany({
      where: { key: { in: groups(value).flatMap((group) => group.keys) } },
      orderBy: { key: 'asc' },
    });
  }
  async function block(
    groupIndex: number,
    boundary: bigint,
    aliases = groups()[groupIndex].keys,
  ) {
    const group = groups()[groupIndex],
      { rate, burst, periodSeconds } = group.settings;
    const state = createGcraState(
      {
        numerator:
          boundary * BigInt(rate) +
          BigInt(burst - 1) * BigInt(periodSeconds) * 1_000_000n,
        denominator: BigInt(rate),
      },
      group.settings,
    );
    await prisma.$transaction((tx) =>
      repository.writeAliases(tx, aliases, group.policy.id, state),
    );
  }

  it('persists one charge in all four policies and every retained alias on a canonical mismatch', async () => {
    const result = await evaluate();
    expect(result.outcome).toBe(Outcome.CANONICAL_MISMATCH);
    const rows = await snapshot();
    expect(rows).toHaveLength(8);
    for (const group of groups())
      for (const row of rows.filter(
        (row) => row.policyId === group.policy.id,
      )) {
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(null, group.settings, result.operationNowMicros),
        );
      }
  });

  it.each([Outcome.MATCH, Outcome.EXCLUDED])(
    'leaves existing debt/audit fields and missing aliases untouched on %s',
    async (outcome) => {
      const now = await repository.operationNowMicros(prisma);
      for (const group of groups())
        await prisma.$transaction((tx) =>
          repository.writeAliases(
            tx,
            [group.keys.find((key) => key.includes(':k1:'))!],
            group.policy.id,
            chargeGcra(null, group.settings, now),
          ),
        );
      const before = await snapshot();
      expect(before).toHaveLength(4);
      expect((await evaluate(input, outcome)).outcome).toBe(outcome);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([0, 1, 2, 3])(
    'enforces policy %s before invoking comparison without partial charge',
    async (index) => {
      const boundary =
        (await repository.operationNowMicros(prisma)) + 30_000_001n;
      await block(index, boundary);
      const before = await snapshot();
      let comparisons = 0;
      const result = await prisma.$transaction((tx) =>
        service.evaluateInTransaction(tx, input, () => {
          comparisons++;
          return Promise.resolve(Outcome.CANONICAL_MISMATCH);
        }),
      );
      expect(result).toMatchObject({
        outcome: 'RATE_LIMITED',
        retryNotBeforeMicros: boundary,
        deniedPolicyIds: [groups()[index].policy.id],
      });
      expect(comparisons).toBe(0);
      expect(await snapshot()).toEqual(before);
    },
  );

  it('returns the latest independent denial boundary with ceiling seconds and sorted policy IDs', async () => {
    const now = await repository.operationNowMicros(prisma);
    await block(0, now + 10_000_001n);
    await block(2, now + 60_000_001n);
    const before = await snapshot();
    const result = await evaluate();
    expect(result).toMatchObject({
      outcome: 'RATE_LIMITED',
      retryNotBeforeMicros: now + 60_000_001n,
      deniedPolicyIds: [
        policies.verificationIdentityLongTerm.id,
        policies.verificationIdentityShortTerm.id,
      ],
    });
    if (result.outcome !== 'RATE_LIMITED') throw new Error('Expected denial.');
    expect(result.retryAfterSeconds).toBe(
      (result.retryNotBeforeMicros - result.operationNowMicros + 999_999n) /
        1_000_000n,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('preserves older alias restriction after active-key promotion without alias repair on denial', async () => {
    const old = groups()[0].keys.find((key) => key.includes(':k1:'))!;
    await block(
      0,
      (await repository.operationNowMicros(prisma)) + 60_000_000n,
      [old],
    );
    const before = await snapshot();
    expect(
      (await evaluate(input, Outcome.CANONICAL_MISMATCH, true)).outcome,
    ).toBe('RATE_LIMITED');
    expect((await evaluate()).outcome).toBe('RATE_LIMITED');
    expect(await snapshot()).toEqual(before);
  });

  it('fails closed on invalid later policy state even when another policy denies', async () => {
    const boundary =
      (await repository.operationNowMicros(prisma)) + 60_000_000n;
    await block(0, boundary);
    await block(3, boundary);
    await prisma.gcraRateLimit.updateMany({
      where: { key: { in: groups()[3].keys } },
      data: { policyId: 'WRONG_POLICY' },
    });
    const before = await snapshot();
    await expect(evaluate()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(await snapshot()).toEqual(before);
  });

  it('admits six rapid same-identity mismatches across clients and IPs, then denies without charging losing IPs', async () => {
    const inputs = Array.from({ length: 16 }, () =>
      context({ normalizedIdentity: input.normalizedIdentity }),
    );
    const results = await Promise.all(
      inputs.map((value, index) =>
        evaluate(value, Outcome.CANONICAL_MISMATCH, index % 2 === 1),
      ),
    );
    expect(
      results.filter((result) => result.outcome === Outcome.CANONICAL_MISMATCH),
    ).toHaveLength(6);
    expect(
      results.filter((result) => result.outcome === 'RATE_LIMITED'),
    ).toHaveLength(10);
    for (let index = 0; index < inputs.length; index++) {
      const rows = await snapshot(inputs[index]);
      if (results[index].outcome === 'RATE_LIMITED')
        expect(
          rows.filter(
            (row) =>
              row.policyId === policies.verificationIpShortTerm.id ||
              row.policyId === policies.verificationIpLongTerm.id,
          ),
        ).toHaveLength(0);
    }
    const charges = results
      .filter((result) => result.outcome === Outcome.CANONICAL_MISMATCH)
      .map((result) => result.operationNowMicros)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const group of groups(input).filter(
      (group) => group.policy.characteristicKind === 'IDENTITY',
    )) {
      let expected = chargeGcra(null, group.settings, charges[0]);
      for (const now of charges.slice(1))
        expected = chargeGcra(expected, group.settings, now);
      for (const row of (await snapshot()).filter(
        (row) => row.policyId === group.policy.id,
      ))
        expect(fromGcraPersistenceData(row)).toEqual(expected);
    }
  });

  it('keeps identity and IP independent: another identity/IP passes and changing IP does not reset identity debt', async () => {
    await block(0, (await repository.operationNowMicros(prisma)) + 60_000_000n);
    expect(
      (
        await evaluate(
          context({ normalizedIdentity: input.normalizedIdentity }),
        )
      ).outcome,
    ).toBe('RATE_LIMITED');
    expect((await evaluate(context())).outcome).toBe(
      Outcome.CANONICAL_MISMATCH,
    );
    await block(1, (await repository.operationNowMicros(prisma)) + 60_000_000n);
    expect(
      (await evaluate(context({ ipAddress: input.ipAddress }))).outcome,
    ).toBe('RATE_LIMITED');
  });

  it('reconciles retained aliases and charges them once across active-key versions', async () => {
    const first = await evaluate(input, Outcome.CANONICAL_MISMATCH, true),
      before = await snapshot();
    const second = await evaluate();
    const after = await snapshot();
    for (const group of groups())
      for (const row of after.filter(
        (row) => row.policyId === group.policy.id,
      )) {
        expect(fromGcraPersistenceData(row)).toEqual(
          chargeGcra(
            chargeGcra(null, group.settings, first.operationNowMicros),
            group.settings,
            second.operationNowMicros,
          ),
        );
      }
    expect(before).toHaveLength(8);
    expect(after).toHaveLength(8);
  });

  it('rolls all mismatch charges back on a later owner failure', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await service.evaluateInTransaction(tx, input, () =>
          Promise.resolve(Outcome.CANONICAL_MISMATCH),
        );
        throw new Error('Owner failed.');
      }),
    ).rejects.toThrow('Owner failed.');
    expect(await snapshot()).toEqual([]);
  });

  it('rolls back callback mutations and all partial aliases even when the owner catches a late SQL write failure', async () => {
    const key = groups()[1].keys.slice().sort()[1],
      schema = `verification_fault_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    const beforeMarker = `verification-before:${randomUUID()}`,
      insideMarker = `verification-inside:${randomUUID()}`;
    subjects.add(beforeMarker);
    subjects.add(insideMarker);
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
      throw new Error('Unexpected test key.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."key"=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected verification write failure.' USING ERRCODE='23514'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${key}')`,
      );
      await prisma.$transaction(async (tx) => {
        await tx.authenticationChallengeSubject.create({
          data: { key: beforeMarker },
        });
        await expect(
          service.evaluateInTransaction(tx, input, async () => {
            await tx.authenticationChallengeSubject.create({
              data: { key: insideMarker },
            });
            return Outcome.CANONICAL_MISMATCH;
          }),
        ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
      });
      expect(await snapshot()).toEqual([]);
      expect(
        await prisma.authenticationChallengeSubject.findUnique({
          where: { key: beforeMarker },
        }),
      ).not.toBeNull();
      expect(
        await prisma.authenticationChallengeSubject.findUnique({
          where: { key: insideMarker },
        }),
      ).toBeNull();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });

  it('compares real canonical OTP/link proofs under a locked challenge without changing its legacy state', async () => {
    const id = randomUUID(),
      key = `verification-proof:${randomUUID()}`;
    subjects.add(key);
    const generated = module
      .get(AuthenticationChallengeProofFactoryService)
      .generate({
        challengeId: id,
        purpose: 'SIGN_IN',
        normalizedIdentity: input.normalizedIdentity,
      });
    await prisma.authenticationChallenge.create({
      data: {
        id,
        subject: { create: { key } },
        identityType: 'INSTITUTIONAL_EMAIL',
        normalizedIdentity: input.normalizedIdentity,
        purpose: 'SIGN_IN',
        ...generated.persistence.hashing,
        ...generated.persistence.encryption,
        otpHash: Uint8Array.from(generated.persistence.hashing.otpHash),
        linkTokenHash: Uint8Array.from(
          generated.persistence.hashing.linkTokenHash,
        ),
        encryptedProof: Uint8Array.from(
          generated.persistence.encryption.encryptedProof,
        ),
        proofEncryptionIv: Uint8Array.from(
          generated.persistence.encryption.proofEncryptionIv,
        ),
        proofEncryptionTag: Uint8Array.from(
          generated.persistence.encryption.proofEncryptionTag,
        ),
        expiresAt: new Date(Date.now() + 600_000),
        retentionExpiresAt: new Date(Date.now() + 86_400_000),
        maxAttempts: 5,
      },
    });
    const before = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id },
    });
    const proof = module.get(AuthenticationChallengeProofService);
    const wrongOtp =
      generated.deliveryProof.otp === '000000' ? '000001' : '000000';
    for (const [method, candidate, expected] of [
      ['OTP', generated.deliveryProof.otp, Outcome.MATCH],
      ['LINK', generated.deliveryProof.linkToken, Outcome.MATCH],
      ['OTP', wrongOtp, Outcome.CANONICAL_MISMATCH],
    ] as const) {
      const result = await prisma.$transaction(async (tx) => {
        const [challenge] = await tx.$queryRaw<
          (AuthenticationChallenge & { expires: string })[]
        >`SELECT *,trunc(EXTRACT(EPOCH FROM "expiresAt")*1000000)::text AS expires FROM "AuthenticationChallenge" WHERE "id"=${id} FOR UPDATE`;
        return service.evaluateInTransaction(
          tx,
          { ...input, expiresAtMicros: BigInt(challenge.expires) },
          () => {
            const context = {
              challengeId: challenge.id,
              purpose: challenge.purpose,
              normalizedIdentity: challenge.normalizedIdentity,
            };
            const matches =
              method === 'OTP'
                ? proof.verifyOtp(
                    context,
                    candidate,
                    challenge.otpHash,
                    challenge.hashProtocolVersion,
                    challenge.hashKeyVersion,
                  )
                : proof.verifyMagicLinkToken(
                    context,
                    candidate,
                    challenge.linkTokenHash,
                    challenge.hashProtocolVersion,
                    challenge.hashKeyVersion,
                  );
            return Promise.resolve(
              matches ? Outcome.MATCH : Outcome.CANONICAL_MISMATCH,
            );
          },
        );
      });
      expect(result.outcome).toBe(expected);
    }
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({ where: { id } }),
    ).toEqual(before);
    expect(
      await prisma.authenticationChallengeDelivery.count({
        where: { challengeId: id },
      }),
    ).toBe(0);
    expect(await snapshot()).toHaveLength(8);
  });

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  async function waitForReplicaLock() {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.$queryRaw<
        { pid: number }[]
      >`SELECT pid FROM pg_stat_activity WHERE application_name=${replicaName} AND wait_event_type='Lock' AND state='active'`;
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Replica did not wait on expected verification locks.');
  }

  it.each(['advisory', 'row'] as const)(
    'checks expiry after a real %s wait without invoking comparison or charging',
    async (kind) => {
      const group = groups()[2],
        key = group.keys[0];
      await prisma.$transaction((tx) =>
        repository.writeAliases(
          tx,
          [key],
          group.policy.id,
          createGcraState({ numerator: 0n, denominator: 1n }, group.settings),
        ),
      );
      const before = await snapshot(),
        value = {
          ...input,
          expiresAtMicros:
            (await repository.operationNowMicros(prisma)) + 800_000n,
        };
      const ready = deferred<void>(),
        release = deferred<void>();
      const holding = prisma.$transaction(
        async (tx) => {
          if (kind === 'advisory') await repository.lockAliases(tx, [key]);
          else
            await tx.$queryRaw`SELECT "key" FROM "GcraRateLimit" WHERE "key"=${key} FOR UPDATE`;
          ready.resolve();
          await release.promise;
        },
        { timeout: 10_000 },
      );
      await ready.promise;
      let comparisons = 0;
      const pending = replica.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', '5s', true)`;
          return replicaService.evaluateInTransaction(tx, value, () => {
            comparisons++;
            return Promise.resolve(Outcome.CANONICAL_MISMATCH);
          });
        },
        { timeout: 10_000 },
      );
      try {
        await waitForReplicaLock();
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(1.1)`;
        release.resolve();
        await holding;
        expect((await pending).outcome).toBe('EXPIRED');
        expect(comparisons).toBe(0);
        expect(await snapshot()).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([holding, pending]);
      }
    },
  );

  it('shares the single-operation transaction guard with common GCRA admission', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await service.evaluateInTransaction(tx, input, () =>
          Promise.resolve(Outcome.MATCH),
        );
        await module.get(GcraAdmissionService).consumeManyInTransaction(tx, []);
      }),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(await snapshot()).toEqual([]);
    await expect(
      service.evaluateInTransaction(prisma, input, () =>
        Promise.resolve(Outcome.MATCH),
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      prisma.$transaction(
        (tx) =>
          service.evaluateInTransaction(tx, input, () =>
            Promise.resolve(Outcome.MATCH),
          ),
        { isolationLevel: 'RepeatableRead' },
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
  });

  it('retries a confirmed write abort only through a new whole-owner transaction', async () => {
    const key = groups()[1].keys.slice().sort()[1],
      schema = `verification_abort_${randomUUID().replaceAll('-', '')}`,
      trigger = `${schema}_trigger`;
    if (!/^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key))
      throw new Error('Unexpected test key.');
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    try {
      await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".attempts`);
      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".fail_write() RETURNS trigger LANGUAGE plpgsql AS $test$ BEGIN IF NEW."key"=TG_ARGV[0] AND nextval('"${schema}".attempts')<=1 THEN RAISE EXCEPTION 'Injected verification abort.' USING ERRCODE='40001'; END IF; RETURN NEW; END $test$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT OR UPDATE ON "GcraRateLimit" FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_write('${key}')`,
      );
      let attempts = 0;
      let committed: Awaited<ReturnType<typeof evaluate>> | undefined;
      while (attempts < 2) {
        attempts++;
        try {
          committed = await evaluate();
          break;
        } catch (error) {
          if (!isRetryableGcraTransactionError(error) || attempts === 2)
            throw error;
        }
      }
      expect(attempts).toBe(2);
      if (!committed) throw new Error('Expected committed mismatch.');
      const rows = await snapshot();
      expect(rows).toHaveLength(8);
      for (const group of groups())
        for (const row of rows.filter(
          (row) => row.policyId === group.policy.id,
        ))
          expect(fromGcraPersistenceData(row)).toEqual(
            chargeGcra(null, group.settings, committed.operationNowMicros),
          );
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${trigger}" ON "GcraRateLimit"`,
      );
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
