import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import type {
  AuthenticationOperation,
  GcraRateLimit,
} from '../../src/generated/prisma/client';
import type { AuthenticationOperationRequest } from '../../src/auth/operations/types/authentication-operation.type';
import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../../src/auth/rate-limit/constants/authentication-global-delivery-admission.constants';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../../src/auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { validateEnvironment } from '../../src/config/environment.validation';
import { MAIL_SUBMISSION_GATE } from '../../src/mail/constants/mail-submission-gate.constants';
import type { NewSessionEmail } from '../../src/mail/types/new-session-email.type';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RateLimitBucketKeyService } from '../../src/rate-limit/services/rate-limit-bucket-key.service';
import { ConcurrencyProcess } from './concurrency-process';
import type {
  ReplicaExecution,
  ReplicaCleanup,
  ReplicaReady,
  ReplicaStopped,
  ReplicaWorkerStarted,
  ReplicaMixedStarted,
  DeferralObservations,
} from './concurrency-protocol';
import { distribution } from './load-utils';
import { loadDatabaseRuntime } from '../utils/test-database-runtime';
import {
  configurationProfiles,
  type ConfigurationProfile,
} from './configuration-fixture';

type Input = {
  request: AuthenticationOperationRequest;
  identity: string;
  ip: string;
};
type Cooldown = {
  key: string;
  count: number;
  boundary: string;
  updatedAt: Date;
};
type Rational = { n: bigint; d: bigint };
type ProviderCall = {
  key: string;
  digest: string;
  replica: number;
  respondedAtMs?: number;
};

// Independent receipt-based accounting oracle. It does not call the limiter's
// charge/evaluation helpers: max(previous TAT, admission time) + period/rate.
function reduced(n: bigint, d: bigint): Rational {
  let a = n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a };
}
function persisted(row: GcraRateLimit): Rational {
  return {
    n: BigInt(row.tatNumerator.toFixed(0)),
    d: BigInt(row.tatDenominator.toFixed(0)),
  };
}
function charged(
  before: Rational,
  now: bigint,
  rate: number,
  period: number,
): Rational {
  const base = before.n > now * before.d ? before.n : now * before.d;
  return reduced(
    base * BigInt(rate) + BigInt(period) * 1000000n * before.d,
    before.d * BigInt(rate),
  );
}

const isolation = process.env.LOAD_STAND_SCENARIO === 'identity-isolation';
const sharedIp = process.env.LOAD_STAND_SCENARIO === 'shared-ip';
const mixedMail = process.env.LOAD_STAND_SCENARIO === 'mixed-mail';
const rollbackCleanup = process.env.LOAD_STAND_SCENARIO === 'rollback-cleanup';
const configMismatch = process.env.LOAD_STAND_SCENARIO === 'config-mismatch';
const scenarioLabel = configMismatch
  ? 'block 2.3.2: configuration mismatch'
  : rollbackCleanup
    ? 'block 2.3.1: rollback and cleanup'
    : mixedMail
      ? 'block 2.2: mixed mail queues'
      : sharedIp
        ? 'block 2.2: shared IP'
        : isolation
          ? 'block 2.2: identity isolation'
          : 'block 2.1: two OS processes';
const testName = configMismatch
  ? 'fails closed on active policy mismatches and preserves debt across matched process restarts'
  : rollbackCleanup
    ? 'rolls back receipt failures and preserves active debt through concurrent and retained cleanup'
    : mixedMail
      ? 'drains auth and notifications across two processes through one real gate without charging capacity waits'
      : sharedIp
        ? 'shares one IP budget across processes without blocking another IP or charging denials'
        : isolation
          ? 'preserves personal cooldown and independent admission during repeated initial/resend traffic'
          : 'shares admission, stable challenge/resend and scheduled delivery across two processes';
describe(`Stage 4 Iteration 7 ${scenarioLabel}`, () => {
  jest.setTimeout(180000);

  it(testName, async () => {
    if (
      !process.env.LOAD_REPLICA_PATH ||
      !process.env.LOAD_REPORT_PATH ||
      process.env.DOTENV_CONFIG_PATH !== '/dev/null'
    )
      throw new Error('Use npm run test:load:concurrency.');
    const databaseLifecycle = loadDatabaseRuntime();
    if (!process.env.LOAD_REPORT_PATH)
      throw new Error('Load report path required.');

    const config = new ConfigService(validateEnvironment({ ...process.env }));
    const prisma = new PrismaService(config);
    const derivation = new RateLimitBucketKeyService(config);
    const keys = (
      policy: (typeof policies)[keyof typeof policies],
      value: string,
    ) => derivation.deriveKeys(policy, value).buckets.map((item) => item.key);
    const calls: ProviderCall[] = [];
    let invalidHttp = 0;
    const server = createServer((request, response) => {
      const hash = createHash('sha256');
      request.on('data', (chunk: Buffer) => hash.update(chunk));
      request.on('end', () => {
        const match = /^\/emails\/([01])$/.exec(request.url ?? '');
        const key = request.headers['idempotency-key'];
        if (!match || request.method !== 'POST' || typeof key !== 'string') {
          invalidHttp++;
          response.writeHead(400).end();
          return;
        }
        // Only transient correlation/digest. Never persist bodies, hashes or keys.
        const call: ProviderCall = {
          key,
          digest: hash.digest('hex'),
          replica: Number(match[1]),
        };
        calls.push(call);
        void delay(100).then(() => {
          call.respondedAtMs = performance.now();
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: 'concurrency-local-accepted' }));
        });
      });
    });
    let pair: ConcurrencyProcess[] = [];
    const scenarios: object[] = [];
    const launched: number[] = [];
    let passed = false;
    const runId = randomUUID();
    const start = performance.now();
    const cooldowns = () => prisma.$queryRaw<Cooldown[]>`
      SELECT key, count, trunc(EXTRACT(EPOCH FROM "windowEndAt") * 1000000)::text AS boundary, "updatedAt"
      FROM "AuthenticationRateLimit" ORDER BY key`;
    const rates = () =>
      prisma.gcraRateLimit.findMany({ orderBy: { key: 'asc' } });
    const now = async () => {
      const [row] = await prisma.$queryRaw<
        { micros: string }[]
      >`SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::text AS micros`;
      return BigInt(row.micros);
    };
    async function newPair(
      endpoint: string,
      profiles?: readonly [ConfigurationProfile, ConfigurationProfile],
    ) {
      pair = [0, 1].map(
        (index) =>
          new ConcurrencyProcess(
            `${endpoint}/emails/${index}`,
            profiles?.[index],
          ),
      );
      const ready = await Promise.all(pair.map((item) => item.ready));
      const [identity] = await prisma.$queryRaw<
        { oid: string }[]
      >`SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()`;
      for (const replica of ready) {
        expect(replica.databaseOid).toBe(identity.oid);
        expect(replica.databaseLifecycle).toEqual(databaseLifecycle);
      }
      expect(
        ready[0].pid !== ready[1].pid &&
          ready.every((item) => item.pid !== process.pid),
      ).toBe(true);
      if (!profiles) {
        expect(isDeepStrictEqual(ready[0].settings, ready[1].settings)).toBe(
          true,
        );
        expect(
          ready.every((replica) =>
            Object.entries(replica.settings).every(
              ([key, value]) => config.getOrThrow<number>(key) === value,
            ),
          ),
        ).toBe(true);
      } else {
        expect(
          configMismatch && databaseLifecycle.stateMode === 'isolated',
        ).toBe(true);
        for (const [index, replica] of ready.entries()) {
          expect(replica.configurationProfile).toBe(profiles[index]);
          const expected = configurationProfiles[profiles[index]] as Readonly<
            Record<string, number>
          >;
          expect(
            Object.entries(replica.settings).every(
              ([key, value]) =>
                value === (expected[key] ?? config.getOrThrow<number>(key)),
            ),
          ).toBe(true);
        }
      }
      launched.push(...ready.map((item) => item.pid));
      return ready;
    }
    async function stopPair(): Promise<ReplicaStopped[]> {
      const results = await Promise.allSettled(pair.map((item) => item.stop()));
      pair = [];
      if (results.some((item) => item.status === 'rejected'))
        throw new Error('Concurrency replica shutdown failed.');
      return results.map(
        (item) => (item as PromiseFulfilledResult<ReplicaStopped>).value,
      );
    }
    function checkAccounting(
      before: GcraRateLimit[],
      after: GcraRateLimit[],
      receipts: AuthenticationOperation[],
      inputs: Map<string, Input>,
    ) {
      const expected = new Map(
        before
          .filter((item) => item.key !== MAIL_SUBMISSION_GATE.key)
          .map((item) => [
            item.key,
            {
              ...persisted(item),
              burst: item.burst,
              rate: item.rate,
              period: item.periodSeconds,
              policy: item.policyId,
            },
          ]),
      );
      for (const receipt of [...receipts]
        .filter((item) => item.outcome === 'CREATED')
        .sort((a, b) =>
          Number(a.admissionNowMicros! - b.admissionNowMicros!),
        )) {
        const input = inputs.get(receipt.id)!;
        const scopes = [
          {
            keys: [globalAdmission.key],
            policy: globalAdmission.policyId,
            prefix: 'AUTH_DELIVERY_GLOBAL',
          },
          {
            keys: keys(policies.deliveryIdentity, input.identity),
            policy: policies.deliveryIdentity.id,
            prefix: 'AUTH_DELIVERY_IDENTITY',
          },
          {
            keys: keys(policies.deliveryIp, input.ip),
            policy: policies.deliveryIp.id,
            prefix: 'AUTH_DELIVERY_IP',
          },
        ];
        for (const scope of scopes)
          for (const key of scope.keys) {
            const rate = config.getOrThrow<number>(`${scope.prefix}_RATE`);
            const period = config.getOrThrow<number>(
              `${scope.prefix}_PERIOD_SECONDS`,
            );
            const burst = config.getOrThrow<number>(`${scope.prefix}_BURST`);
            const previous = expected.get(key) ?? {
              n: 0n,
              d: 1n,
              rate: BigInt(rate),
              period: BigInt(period),
              burst: BigInt(burst),
              policy: scope.policy,
            };
            const time = receipt.admissionNowMicros!;
            if (
              previous.n * BigInt(rate) >
              time * previous.d * BigInt(rate) +
                BigInt(burst - 1) * BigInt(period) * 1000000n * previous.d
            )
              return false;
            expected.set(key, {
              ...charged(previous, time, rate, period),
              rate: BigInt(rate),
              period: BigInt(period),
              burst: BigInt(burst),
              policy: scope.policy,
            });
          }
      }
      const actual = after.filter(
        (item) => item.key !== MAIL_SUBMISSION_GATE.key,
      );
      return (
        actual.length === expected.size &&
        actual.every((row) => {
          const value = expected.get(row.key),
            observed = persisted(row);
          return (
            value &&
            observed.n * value.d === value.n * observed.d &&
            row.burst === value.burst &&
            row.rate === value.rate &&
            row.periodSeconds === value.period &&
            row.policyId === value.policy &&
            row.idleAfterMicros.toFixed(0) ===
              ((value.n + value.d - 1n) / value.d).toString()
          );
        })
      );
    }
    function checkCooldowns(
      before: Cooldown[],
      after: Cooldown[],
      receipts: AuthenticationOperation[],
      inputs: Map<string, Input>,
    ) {
      const expected = new Map(before.map((row) => [row.key, row.boundary]));
      for (const receipt of receipts.filter(
        (row) => row.outcome === 'CREATED',
      )) {
        const input = inputs.get(receipt.id)!;
        const scopes = [
          {
            keys: keys(
              policies.challengeDeliveryCooldown,
              receipt.challengeId!,
            ),
            seconds: config.getOrThrow<number>(
              'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
            ),
          },
          {
            keys: keys(policies.identityDeliveryCooldown, input.identity),
            seconds: config.getOrThrow<number>(
              'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
            ),
          },
        ];
        for (const scope of scopes)
          for (const key of scope.keys)
            expected.set(
              key,
              (
                receipt.admissionNowMicros! +
                BigInt(scope.seconds) * 1000000n
              ).toString(),
            );
      }
      return (
        expected.size === after.length &&
        after.every(
          (row) => row.count === 1 && expected.get(row.key) === row.boundary,
        )
      );
    }
    const proofSnapshot = (challengeId: string) =>
      prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: {
          expiresAt: true,
          retentionExpiresAt: true,
          otpHash: true,
          linkTokenHash: true,
          encryptedProof: true,
          proofEncryptionIv: true,
          proofEncryptionTag: true,
          hashProtocolVersion: true,
          hashKeyVersion: true,
          encryptionProtocolVersion: true,
          encryptionKeyVersion: true,
          failedAttemptCount: true,
          lockedAt: true,
          consumedAt: true,
        },
      });
    async function executeBatch(inputs: Input[]) {
      const partitions = [
        inputs.filter((_, index) => index % 2 === 0),
        inputs.filter((_, index) => index % 2 === 1),
      ];
      const operationIds = await Promise.all(
        pair.map((item, index) =>
          item.call<string[]>({
            kind: 'PREPARE',
            requests: partitions[index].map((entry) => entry.request),
          }),
        ),
      );
      const byId = new Map(
        operationIds.flatMap((ids, index) =>
          ids.map((id, offset) => [id, partitions[index][offset]] as const),
        ),
      );
      const execution = await Promise.all(
        pair.map((item) => item.call<ReplicaExecution[]>({ kind: 'EXECUTE' })),
      );
      const all = execution.flat();
      const receipts = await prisma.authenticationOperation.findMany({
        where: { id: { in: [...byId.keys()] } },
      });
      return { byId, execution, all, receipts };
    }
    async function phase(
      name: string,
      inputs: Input[],
      expectedCreated: number,
      expectedOther: 'REUSED' | 'EXISTING' | undefined,
      ready: ReplicaReady[],
    ) {
      const beforeRates = await rates(),
        beforeCooldown = await cooldowns();
      const { byId, execution, all, receipts } = await executeBatch(inputs);
      const afterAdmission = await rates(),
        afterCooldown = await cooldowns();
      const created = receipts.filter((item) => item.outcome === 'CREATED');
      const challenges = await prisma.authenticationChallenge.findMany({
        where: {
          normalizedIdentity: {
            in: [...new Set(inputs.map((item) => item.identity))],
          },
        },
        select: { id: true },
      });
      const deliveries = await prisma.authenticationChallengeDelivery.findMany({
        where: { challengeId: { in: challenges.map((item) => item.id) } },
        orderBy: { createdAt: 'asc' },
      });
      const newDeliveries = deliveries.filter((item) =>
        created.some((receipt) => receipt.deliveryId === item.id),
      );
      const outcomes = execution.map((entries) => {
        const counts: Record<string, number> = {};
        for (const item of entries) {
          const result = item.response?.result;
          const label =
            item.error ??
            (result?.outcome === 'DENIED'
              ? result.denial
              : (result?.outcome ?? 'MISSING'));
          counts[label] = (counts[label] ?? 0) + 1;
        }
        return counts;
      });
      const checks: Record<string, boolean> = {
        allOperationsCommitted:
          receipts.length === inputs.length &&
          all.every(
            (item) => item.response && !item.error && !item.response.replayed,
          ),
        expectedOutcomes:
          created.length === expectedCreated &&
          receipts.every(
            (item) =>
              item.outcome === 'CREATED' || item.outcome === expectedOther,
          ),
        correctDomainCounts:
          challenges.length === expectedCreated &&
          deliveries.length ===
            expectedCreated + (name === 'same-challenge-resend' ? 1 : 0),
        oneReceiptPerOperation:
          new Set(receipts.map((item) => item.id)).size === inputs.length,
        responsesMatchReceipts: receipts.every((receipt) => {
          const response = all.find((item) => item.operationId === receipt.id)
            ?.response?.result;
          return (
            response &&
            response.outcome === receipt.outcome &&
            'challengeId' in response &&
            response.challengeId === receipt.challengeId &&
            (!('deliveryId' in response) ||
              response.deliveryId === receipt.deliveryId)
          );
        }),
        exactCommittedCharges: checkAccounting(
          beforeRates,
          afterAdmission,
          receipts,
          byId,
        ),
        exactCooldowns: checkCooldowns(
          beforeCooldown,
          afterCooldown,
          receipts,
          byId,
        ),
        queuedBeforeWorkers:
          newDeliveries.length === expectedCreated &&
          newDeliveries.every(
            (item) =>
              item.status === 'PENDING' &&
              item.attemptCount === 0 &&
              item.origin ===
                (name === 'same-challenge-resend' ? 'RESEND' : 'INITIAL'),
          ),
      };
      const entry = {
        name,
        processes: ready,
        operations: inputs.length,
        outcomes,
        operationLatencyMs: distribution(all.map((item) => item.elapsedMs)),
        createdDeliveries: newDeliveries.length,
        checks,
        workerClaims: [] as number[],
        providerCallsByReplica: [] as number[],
        grantedPermissions: 0,
        gateDeferrals: 0,
      };
      scenarios.push(entry);
      expect(Object.values(checks).every(Boolean)).toBe(true);
      const proof = await Promise.all(
        challenges.map((item) => proofSnapshot(item.id)),
      );
      const previousCalls = calls.length;
      const workers = await Promise.all(
        pair.map((item) =>
          item.call<ReplicaWorkerStarted>({ kind: 'START_WORKER' }),
        ),
      );
      entry.workerClaims = workers.map((item) => item.summary.claimedCount);
      const deadline = performance.now() + 20000;
      let pending: number;
      do {
        pending = await prisma.authenticationChallengeDelivery.count({
          where: {
            id: { in: newDeliveries.map((item) => item.id) },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
        });
        if (pending) await delay(100);
      } while (pending && performance.now() < deadline);
      const stopped = await stopPair();
      const grants = stopped
        .flatMap((item) => item.grants)
        .sort((a, b) => Number(a.now - b.now));
      entry.grantedPermissions = grants.length;
      entry.gateDeferrals = stopped.reduce(
        (sum, item) => sum + item.deferredCount,
        0,
      );
      const submissions = calls.slice(previousCalls);
      entry.providerCallsByReplica = [0, 1].map(
        (replica) =>
          submissions.filter((item) => item.replica === replica).length,
      );
      const finalDeliveries =
        await prisma.authenticationChallengeDelivery.findMany({
          where: { id: { in: newDeliveries.map((item) => item.id) } },
        });
      const afterWorkers = await rates();
      const gate = afterWorkers.find(
        (item) => item.key === MAIL_SUBMISSION_GATE.key,
      );
      const oldGate = afterAdmission.find(
        (item) => item.key === MAIL_SUBMISSION_GATE.key,
      );
      const oldGateTime = oldGate ? persisted(oldGate) : { n: 0n, d: 1n };
      const interval =
        1000000n /
        BigInt(config.getOrThrow<number>('MAIL_RESEND_SUBMISSIONS_PER_SECOND'));
      checks.sharedGateSpacing =
        grants.length === expectedCreated &&
        grants.every(
          (item, index) =>
            item.next === item.now + interval &&
            (index
              ? item.now >= grants[index - 1].next
              : item.now * oldGateTime.d >= oldGateTime.n),
        );
      checks.sharedGatePersisted =
        !!gate &&
        grants.length > 0 &&
        gate.tatNumerator.toFixed(0) === grants.at(-1)!.next.toString() &&
        gate.tatDenominator.toFixed(0) === '1';
      checks.noRepeatedSubmission =
        submissions.length === expectedCreated &&
        new Set(submissions.map((item) => item.key)).size === expectedCreated &&
        finalDeliveries.every((item) =>
          submissions.some((call) => call.key === item.idempotencyKey),
        );
      checks.allCreatedSentOnce =
        finalDeliveries.length === expectedCreated &&
        finalDeliveries.every(
          (item) => item.status === 'SENT' && item.attemptCount === 1,
        );
      checks.workersDoNotRecharge =
        isDeepStrictEqual(
          afterAdmission.filter(
            (item) => item.key !== MAIL_SUBMISSION_GATE.key,
          ),
          afterWorkers.filter((item) => item.key !== MAIL_SUBMISSION_GATE.key),
        ) && isDeepStrictEqual(afterCooldown, await cooldowns());
      checks.stableProofAndLifetime = isDeepStrictEqual(
        proof,
        await Promise.all(challenges.map((item) => proofSnapshot(item.id))),
      );
      checks.noInvalidHttp = invalidHttp === 0;
      if (expectedCreated > 1)
        checks.bothWorkersClaimed = entry.workerClaims.every(
          (count) => count > 0,
        );
      expect(Object.values(checks).every(Boolean)).toBe(true);
      return {
        challengeId: challenges[0].id,
        initialDigest: submissions[0].digest,
        proof: proof[0],
        checks,
      };
    }
    async function drainDeliveries(deliveryIds: string[]) {
      const previousCalls = calls.length;
      const workers = await Promise.all(
        pair.map((item) =>
          item.call<ReplicaWorkerStarted>({ kind: 'START_WORKER' }),
        ),
      );
      const deadline = performance.now() + 20000;
      let pending: number;
      do {
        pending = await prisma.authenticationChallengeDelivery.count({
          where: {
            id: { in: deliveryIds },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
        });
        if (pending) await delay(100);
      } while (pending && performance.now() < deadline);
      const stopped = await stopPair();
      const final = await prisma.authenticationChallengeDelivery.findMany({
        where: { id: { in: deliveryIds } },
      });
      return {
        final,
        stopped,
        submissions: calls.slice(previousCalls),
        afterWorkers: await rates(),
        workerClaims: workers.map((item) => item.summary.claimedCount),
      };
    }
    async function isolateIdentity(
      endpoint: string,
      initial: (identity: string, ip: string) => Input,
    ) {
      const identity = `${runId}-active@load.example.edu`,
        ip = '2001:db8:3::1';
      const activeInitial = initial(identity, ip);
      const seed = await phase(
        'active-identity-seed',
        [activeInitial, activeInitial],
        1,
        'REUSED',
        await newPair(endpoint),
      );
      const activeChallenge =
        await prisma.authenticationChallenge.findUniqueOrThrow({
          where: { id: seed.challengeId },
        });
      const activeDeliveries =
        await prisma.authenticationChallengeDelivery.findMany({
          where: { challengeId: seed.challengeId },
          orderBy: { id: 'asc' },
        });
      const activeRateKeys = [
        ...keys(policies.deliveryIdentity, identity),
        ...keys(policies.deliveryIp, ip),
      ];
      const activeCooldownKeys = [
        ...keys(policies.identityDeliveryCooldown, identity),
        ...keys(policies.challengeDeliveryCooldown, seed.challengeId),
      ];
      const seedCooldowns = (await cooldowns()).filter((item) =>
        activeCooldownKeys.includes(item.key),
      );
      expect(seedCooldowns.length).toBe(activeCooldownKeys.length);
      const boundary = seedCooldowns
        .map((item) => BigInt(item.boundary))
        .reduce((a, b) => (a > b ? a : b));
      const activeResend: Input = {
        identity,
        ip,
        request: {
          kind: 'RESEND',
          input: {
            challengeId: seed.challengeId,
            ipAddress: ip,
            templateProtocolVersion: 1,
            retentionExpiresAt: activeChallenge.retentionExpiresAt,
          },
        },
      };
      const ready = await newPair(endpoint);
      const normalDeliveryIds: string[] = [];
      const previousCalls = calls.length;
      const normalLatency: number[] = [];
      const denialPolicies = [
        policies.challengeDeliveryCooldown.id,
        policies.identityDeliveryCooldown.id,
      ].sort();
      for (let wave = 0; wave < 3; wave++) {
        // Each process gets two INITIALs + two RESENDs; one also gets the
        // independent identity. This tests both kinds on both replicas.
        const normal = initial(
          `${runId}-independent-${wave}@load.example.edu`,
          `2001:db8:4::${wave + 1}`,
        );
        const inputs = [
          ...Array.from({ length: 8 }, (_, index) =>
            index % 4 < 2 ? activeInitial : activeResend,
          ),
          normal,
        ];
        expect((await now()) < boundary).toBe(true);
        const beforeRates = await rates(),
          beforeCooldown = await cooldowns();
        const { all, receipts, byId, execution } = await executeBatch(inputs);
        const afterRates = await rates(),
          afterCooldown = await cooldowns();
        const normalResult = all.find(
          (item) => byId.get(item.operationId)?.identity === normal.identity,
        );
        if (normalResult) normalLatency.push(normalResult.elapsedMs);
        const normalRows = await prisma.authenticationChallenge.findMany({
          where: { normalizedIdentity: normal.identity },
          select: { id: true },
        });
        const deliveries =
          await prisma.authenticationChallengeDelivery.findMany({
            where: { challengeId: { in: normalRows.map((row) => row.id) } },
          });
        normalDeliveryIds.push(...deliveries.map((row) => row.id));
        const denied = receipts.filter((row) => row.outcome === 'DENIED');
        const checks = {
          allOperationsCommitted:
            receipts.length === 9 &&
            new Set(receipts.map((row) => row.id)).size === 9 &&
            all.length === 9 &&
            all.every(
              (item) =>
                !item.error &&
                item.response &&
                !item.response.replayed &&
                item.response.operationId === item.operationId,
            ),
          expectedIdentityOutcomes: receipts.every((row) => {
            const input = byId.get(row.id)!;
            const expected =
              input.identity === normal.identity
                ? 'CREATED'
                : input.request.kind === 'SIGN_IN_REQUEST'
                  ? 'REUSED'
                  : 'DENIED';
            return (
              row.outcome === expected &&
              (expected === 'DENIED'
                ? row.challengeId === null && row.deliveryId === null
                : row.challengeId ===
                  (expected === 'REUSED'
                    ? seed.challengeId
                    : normalRows[0]?.id))
            );
          }),
          exactCooldownDenialReasons:
            denied.length === 4 &&
            denied.every(
              (row) =>
                row.denial === 'RATE_LIMITED' &&
                isDeepStrictEqual(row.deniedPolicyIds, denialPolicies) &&
                row.retryNotBeforeMicros?.toFixed(0) === boundary.toString() &&
                row.evaluatedAtMicros < boundary &&
                row.admissionNowMicros === null,
            ),
          responsesMatchReceipts: receipts.every((row) => {
            const response = all.find((item) => item.operationId === row.id)
              ?.response?.result;
            return (
              response &&
              response.outcome === row.outcome &&
              (response.outcome === 'DENIED'
                ? response.denial === row.denial &&
                  response.retryNotBeforeMicros === boundary &&
                  response.deniedPolicyIds.length ===
                    row.deniedPolicyIds.length &&
                  response.deniedPolicyIds.every(
                    (policy, index) => policy === row.deniedPolicyIds[index],
                  ) &&
                  response.remainingWaitSeconds !== null &&
                  response.remainingWaitSeconds > 0n &&
                  response.remainingWaitSeconds <= 60n
                : response.challengeId === row.challengeId &&
                  (!('deliveryId' in response) ||
                    response.deliveryId === row.deliveryId))
            );
          }),
          independentIdentityAdmitted:
            normalResult?.response?.result.outcome === 'CREATED' &&
            normalRows.length === 1 &&
            deliveries.length === 1 &&
            deliveries[0].status === 'PENDING' &&
            deliveries[0].attemptCount === 0 &&
            deliveries[0].origin === 'INITIAL',
          onlyIndependentDeliveryCharged: checkAccounting(
            beforeRates,
            afterRates,
            receipts,
            byId,
          ),
          exactCooldownAccounting: checkCooldowns(
            beforeCooldown,
            afterCooldown,
            receipts,
            byId,
          ),
          activePersonalDebtUnchanged: isDeepStrictEqual(
            beforeRates.filter((item) => activeRateKeys.includes(item.key)),
            afterRates.filter((item) => activeRateKeys.includes(item.key)),
          ),
          activeCooldownNotExtended: isDeepStrictEqual(
            seedCooldowns,
            afterCooldown.filter((item) =>
              activeCooldownKeys.includes(item.key),
            ),
          ),
          activeChallengeUnchanged: isDeepStrictEqual(
            activeChallenge,
            await prisma.authenticationChallenge.findUniqueOrThrow({
              where: { id: seed.challengeId },
            }),
          ),
          noActiveDeliveryCreatedOrChanged: isDeepStrictEqual(
            activeDeliveries,
            await prisma.authenticationChallengeDelivery.findMany({
              where: { challengeId: seed.challengeId },
              orderBy: { id: 'asc' },
            }),
          ),
          noHttpBeforeWorkers: calls.length === previousCalls,
        };
        scenarios.push({
          name: `identity-isolation-wave-${wave + 1}`,
          processes: ready,
          operations: 9,
          activeIdentityOutcomes: {
            expectedReused: 4,
            expectedRateLimited: 4,
            observedReused: receipts.filter((row) => row.outcome === 'REUSED')
              .length,
            observedRateLimited: denied.filter(
              (row) => row.denial === 'RATE_LIMITED',
            ).length,
          },
          outcomesByProcess: execution.map((entries) => {
            const counts: Record<string, number> = {};
            for (const item of entries) {
              const result = item.response?.result;
              const label =
                item.error ??
                (result?.outcome === 'DENIED'
                  ? result.denial
                  : (result?.outcome ?? 'MISSING'));
              counts[label] = (counts[label] ?? 0) + 1;
            }
            return counts;
          }),
          deniedPolicyCounts: Object.fromEntries(
            denialPolicies.map((policy) => [
              policy,
              denied.filter((row) => row.deniedPolicyIds.includes(policy))
                .length,
            ]),
          ),
          independentOperationLatencyMs: distribution(
            normalResult ? [normalResult.elapsedMs] : [],
          ),
          allOperationLatencyMs: distribution(
            all.map((item) => item.elapsedMs),
          ),
          checks,
        });
        expect(Object.values(checks).every(Boolean)).toBe(true);
      }
      const beforeWorkers = await rates(),
        cooldownBeforeWorkers = await cooldowns();
      const { stopped, final, submissions, afterWorkers } =
        await drainDeliveries(normalDeliveryIds);
      const checks = {
        independentDeliveriesSentOnce:
          final.length === 3 &&
          final.every((row) => row.status === 'SENT' && row.attemptCount === 1),
        noDuplicateHttp:
          submissions.length === 3 &&
          new Set(submissions.map((item) => item.key)).size === 3 &&
          final.every((row) =>
            submissions.some((call) => call.key === row.idempotencyKey),
          ),
        exactlyThreeSharedPermissions:
          stopped.reduce((sum, item) => sum + item.grants.length, 0) === 3,
        noAdmissionRecharge:
          isDeepStrictEqual(
            beforeWorkers.filter(
              (item) => item.key !== MAIL_SUBMISSION_GATE.key,
            ),
            afterWorkers.filter(
              (item) => item.key !== MAIL_SUBMISSION_GATE.key,
            ),
          ) && isDeepStrictEqual(cooldownBeforeWorkers, await cooldowns()),
        activeProofAndLifetimeUnchanged: isDeepStrictEqual(
          seed.proof,
          await proofSnapshot(seed.challengeId),
        ),
        noInvalidHttp: invalidHttp === 0,
      };
      scenarios.push({
        name: 'independent-delivery-drain',
        independentOperationLatencyMs: distribution(normalLatency),
        sent: final.filter((row) => row.status === 'SENT').length,
        providerCalls: submissions.length,
        checks,
      });
      expect(Object.values(checks).every(Boolean)).toBe(true);
    }
    async function shareIp(
      endpoint: string,
      initial: (identity: string, ip: string) => Input,
    ) {
      expect([
        config.getOrThrow<number>('AUTH_DELIVERY_IP_BURST'),
        config.getOrThrow<number>('AUTH_DELIVERY_IP_RATE'),
        config.getOrThrow<number>('AUTH_DELIVERY_IP_PERIOD_SECONDS'),
      ]).toEqual([3, 1, 3600]);
      const prefix = `2001:db8:${runId.replaceAll('-', '').slice(0, 20).match(/.{4}/g)!.join(':')}`;
      const crowdedIp = `${prefix}:1`,
        otherIp = `${prefix}:2`;
      const crowdedKeys = keys(policies.deliveryIp, crowdedIp);
      const otherKeys = keys(policies.deliveryIp, otherIp);
      expect(
        (await rates()).some((row) =>
          [...crowdedKeys, ...otherKeys].includes(row.key),
        ),
      ).toBe(false);
      const ready = await newPair(endpoint);
      const createdIds: string[] = [];
      let originalSharedState: GcraRateLimit[] | undefined;
      let originalBoundary: bigint | undefined;
      for (let wave = 0; wave < 3; wave++) {
        const sharedCount = wave === 0 ? 6 : 4;
        const shared = Array.from({ length: sharedCount }, (_, index) =>
          initial(
            `${runId}-shared-${wave}-${index}@load.example.edu`,
            crowdedIp,
          ),
        );
        const independent = initial(
          `${runId}-other-${wave}@load.example.edu`,
          otherIp,
        );
        const inputs = [...shared, independent];
        const beforeRates = await rates(),
          beforeCooldown = await cooldowns();
        const { receipts, all, byId, execution } = await executeBatch(inputs);
        const afterRates = await rates(),
          afterCooldown = await cooldowns();
        const created = receipts.filter((row) => row.outcome === 'CREATED');
        const denied = receipts.filter((row) => row.outcome === 'DENIED');
        const sharedCreated = created.filter(
          (row) => byId.get(row.id)?.ip === crowdedIp,
        );
        const sharedState = afterRates.filter((row) =>
          crowdedKeys.includes(row.key),
        );
        expect(sharedState.length).toBe(crowdedKeys.length);
        const state = persisted(sharedState[0]);
        const rate = 1n,
          periodMicros = 3600000000n,
          burst = 3n;
        const eligibleNumerator =
          state.n * rate - (burst - 1n) * periodMicros * state.d;
        const eligibleDenominator = state.d * rate;
        const boundary =
          (eligibleNumerator + eligibleDenominator - 1n) / eligibleDenominator;
        const deniedIdentities = denied.map(
          (row) => byId.get(row.id)!.identity,
        );
        const [deniedChallenges, deniedDeliveries, deniedSubjects] =
          await Promise.all([
            prisma.authenticationChallenge.count({
              where: { normalizedIdentity: { in: deniedIdentities } },
            }),
            prisma.authenticationChallengeDelivery.count({
              where: { recipientSnapshot: { in: deniedIdentities } },
            }),
            prisma.authenticationChallengeSubject.count({
              where: { normalizedIdentity: { in: deniedIdentities } },
            }),
          ]);
        const challenges = await prisma.authenticationChallenge.findMany({
          where: {
            normalizedIdentity: { in: inputs.map((item) => item.identity) },
          },
          select: { id: true },
        });
        const deliveries =
          await prisma.authenticationChallengeDelivery.findMany({
            where: { challengeId: { in: challenges.map((row) => row.id) } },
          });
        createdIds.push(...deliveries.map((row) => row.id));
        const expectedCreated = wave === 0 ? 4 : 1;
        const checks = {
          allOperationsCommitted:
            all.length === inputs.length &&
            receipts.length === inputs.length &&
            new Set(receipts.map((row) => row.id)).size === inputs.length &&
            all.every(
              (item) =>
                !item.error &&
                item.response &&
                !item.response.replayed &&
                item.response.operationId === item.operationId,
            ),
          sharedBurstEnforcedAcrossProcesses:
            sharedCreated.length === (wave === 0 ? 3 : 0) &&
            created.length === expectedCreated &&
            denied.length === (wave === 0 ? 3 : 4),
          onlySharedIpDenies: denied.every(
            (row) =>
              byId.get(row.id)?.ip === crowdedIp &&
              row.denial === 'RATE_LIMITED' &&
              row.deniedPolicyIds.length === 1 &&
              row.deniedPolicyIds[0] === policies.deliveryIp.id &&
              row.challengeId === null &&
              row.deliveryId === null &&
              row.admissionNowMicros === null,
          ),
          exactRecoveryBoundary:
            denied.every(
              (row) =>
                row.retryNotBeforeMicros?.toFixed(0) === boundary.toString() &&
                row.evaluatedAtMicros < boundary,
            ) &&
            (originalBoundary === undefined || boundary === originalBoundary),
          responsesMatchReceipts: receipts.every((row) => {
            const response = all.find((item) => item.operationId === row.id)
              ?.response?.result;
            if (response?.outcome !== row.outcome) return false;
            if (response.outcome === 'CREATED')
              return (
                response.challengeId === row.challengeId &&
                response.deliveryId === row.deliveryId
              );
            return (
              response.outcome === 'DENIED' &&
              response.denial === row.denial &&
              response.deniedPolicyIds.length === 1 &&
              response.deniedPolicyIds[0] === policies.deliveryIp.id &&
              response.retryNotBeforeMicros === boundary &&
              response.remainingWaitSeconds !== null &&
              response.remainingWaitSeconds > 0n &&
              response.remainingWaitSeconds <= 3600n
            );
          }),
          otherIpAdmitted:
            created.filter(
              (row) => byId.get(row.id)?.identity === independent.identity,
            ).length === 1,
          noDomainRowsForDenied:
            deniedChallenges === 0 &&
            deniedDeliveries === 0 &&
            deniedSubjects === 0,
          exactChargesForCreatedOnly: checkAccounting(
            beforeRates,
            afterRates,
            receipts,
            byId,
          ),
          exactCooldownsForCreatedOnly: checkCooldowns(
            beforeCooldown,
            afterCooldown,
            receipts,
            byId,
          ),
          denialsDoNotChangeSharedState:
            originalSharedState === undefined ||
            isDeepStrictEqual(originalSharedState, sharedState),
          onlyCreatedDeliveriesQueued:
            challenges.length === expectedCreated &&
            deliveries.length === expectedCreated &&
            deliveries.every(
              (row) =>
                row.status === 'PENDING' &&
                row.attemptCount === 0 &&
                row.origin === 'INITIAL' &&
                created.some(
                  (receipt) =>
                    receipt.deliveryId === row.id &&
                    receipt.challengeId === row.challengeId,
                ),
            ),
          noHttpBeforeWorkers: calls.length === 0,
        };
        scenarios.push({
          name: `shared-ip-wave-${wave + 1}`,
          processes: ready,
          operations: inputs.length,
          crowdedIp: {
            offered: sharedCount,
            created: sharedCreated.length,
            denied: denied.length,
          },
          otherIp: {
            offered: 1,
            created: created.filter((row) => byId.get(row.id)?.ip === otherIp)
              .length,
          },
          outcomesByProcess: execution.map((entries) => {
            const counts: Record<string, number> = {};
            for (const item of entries) {
              const result = item.response?.result;
              const label =
                item.error ??
                (result?.outcome === 'DENIED'
                  ? result.denial
                  : (result?.outcome ?? 'MISSING'));
              counts[label] = (counts[label] ?? 0) + 1;
            }
            return counts;
          }),
          deniedPolicyCounts: {
            [policies.deliveryIp.id]: denied.filter((row) =>
              row.deniedPolicyIds.includes(policies.deliveryIp.id),
            ).length,
          },
          operationLatencyMs: distribution(all.map((item) => item.elapsedMs)),
          checks,
        });
        expect(Object.values(checks).every(Boolean)).toBe(true);
        originalSharedState ??= sharedState;
        originalBoundary ??= boundary;
      }
      const beforeWorkers = await rates(),
        cooldownBeforeWorkers = await cooldowns();
      const { stopped, final, submissions, afterWorkers, workerClaims } =
        await drainDeliveries(createdIds);
      const checks = {
        sixCreatedDeliveriesSentOnce:
          final.length === 6 &&
          final.every((row) => row.status === 'SENT' && row.attemptCount === 1),
        exactlySixProviderCalls:
          submissions.length === 6 &&
          new Set(submissions.map((item) => item.key)).size === 6 &&
          final.every((row) =>
            submissions.some((call) => call.key === row.idempotencyKey),
          ),
        exactlySixSharedPermissions:
          stopped.reduce((sum, item) => sum + item.grants.length, 0) === 6,
        workersDoNotRecharge:
          isDeepStrictEqual(
            beforeWorkers.filter((row) => row.key !== MAIL_SUBMISSION_GATE.key),
            afterWorkers.filter((row) => row.key !== MAIL_SUBMISSION_GATE.key),
          ) && isDeepStrictEqual(cooldownBeforeWorkers, await cooldowns()),
        crowdedIpStateStillUnchanged: isDeepStrictEqual(
          originalSharedState,
          afterWorkers.filter((row) => crowdedKeys.includes(row.key)),
        ),
        noInvalidHttp: invalidHttp === 0,
      };
      scenarios.push({
        name: 'shared-ip-delivery-drain',
        sent: final.filter((row) => row.status === 'SENT').length,
        providerCalls: submissions.length,
        workerClaims,
        checks,
      });
      expect(Object.values(checks).every(Boolean)).toBe(true);
    }
    async function mixMail(
      endpoint: string,
      initial: (identity: string, ip: string) => Input,
    ) {
      const ready = await newPair(endpoint);
      const beforeRates = await rates(),
        beforeCooldown = await cooldowns();
      const inputs = Array.from({ length: 4 }, (_, index) =>
        initial(
          `${runId}-mixed-auth-${index}@load.example.edu`,
          `2001:db8:5::${index + 1}`,
        ),
      );
      const batch = await executeBatch(inputs);
      const afterAuthRates = await rates(),
        afterAuthCooldown = await cooldowns();
      const authRows = await prisma.authenticationChallengeDelivery.findMany({
        where: {
          id: {
            in: batch.receipts.flatMap((row) =>
              row.deliveryId ? [row.deliveryId] : [],
            ),
          },
        },
        orderBy: { id: 'asc' },
      });
      const proof = await Promise.all(
        authRows.map((row) => proofSnapshot(row.challengeId)),
      );
      const receiptIds = batch.receipts.map((row) => row.id);
      const receiptBefore = await prisma.authenticationOperation.findMany({
        where: { id: { in: receiptIds } },
        orderBy: { id: 'asc' },
      });
      const notifications: NewSessionEmail[] = Array.from(
        { length: 4 },
        (_, index) => ({
          recipient: `${runId}-mixed-notification-${index}@load.example.edu`,
          idempotencyKey: `load:mixed:${runId}:${index}`,
          occurredAt: new Date(),
          platform: 'WEB',
          deviceModel: null,
          osVersion: null,
          appVersion: null,
          locationCountryCode: null,
          locationCity: null,
          riskLevel: null,
          riskSignals: [],
        }),
      );
      const notificationIds = (
        await Promise.all(
          pair.map((item, index) =>
            item.call<string[]>({
              kind: 'ENQUEUE_NOTIFICATIONS',
              notifications: notifications.slice(index * 2, index * 2 + 2),
            }),
          ),
        )
      ).flat();
      const notificationRows = await prisma.notificationDelivery.findMany({
        where: { id: { in: notificationIds } },
        orderBy: { id: 'asc' },
      });
      const afterEnqueueRates = await rates(),
        afterEnqueueCooldown = await cooldowns();
      const beforeGate = afterEnqueueRates.find(
        (row) => row.key === MAIL_SUBMISSION_GATE.key,
      );
      const checks: Record<string, boolean> = {
        fourAuthAdmitted:
          batch.receipts.length === 4 &&
          batch.receipts.every((row) => row.outcome === 'CREATED') &&
          batch.all.every(
            (item) =>
              item.response?.result.outcome === 'CREATED' &&
              !item.error &&
              !item.response.replayed,
          ),
        exactAuthCharges:
          checkAccounting(
            beforeRates,
            afterAuthRates,
            batch.receipts,
            batch.byId,
          ) &&
          checkCooldowns(
            beforeCooldown,
            afterAuthCooldown,
            batch.receipts,
            batch.byId,
          ),
        authQueuedUncharged:
          authRows.length === 4 &&
          authRows.every(
            (row) =>
              row.status === 'PENDING' &&
              row.attemptCount === 0 &&
              row.attemptedAt === null &&
              row.processingLeaseId === null,
          ),
        notificationsDurablyQueued:
          notificationRows.length === 4 &&
          new Set(notificationIds).size === 4 &&
          notificationRows.every(
            (row) =>
              row.status === 'PENDING' &&
              row.channel === 'EMAIL' &&
              row.type === 'NEW_SESSION' &&
              row.mailQueuedAt !== null &&
              row.mailPayload !== null &&
              row.mailAttemptCount === 0 &&
              row.attemptedAt === null &&
              row.mailLeaseId === null,
          ),
        notificationsDoNotChargeAuth:
          isDeepStrictEqual(afterAuthRates, afterEnqueueRates) &&
          isDeepStrictEqual(afterAuthCooldown, afterEnqueueCooldown),
        noHttpBeforeWorkers: calls.length === 0,
      };
      const entry = {
        name: 'mixed-mail-queues',
        processes: ready,
        queued: {
          auth: authRows.length,
          notifications: notificationRows.length,
        },
        checks,
      };
      scenarios.push(entry);
      expect(Object.values(checks).every(Boolean)).toBe(true);
      const workerStart = performance.now();
      const workers = await Promise.all(
        pair.map((item) =>
          item.call<ReplicaMixedStarted>({ kind: 'START_MIXED_WORKERS' }),
        ),
      );
      const deadline = performance.now() + 20000;
      let unfinished: number;
      do {
        const pending = await Promise.all([
          prisma.authenticationChallengeDelivery.count({
            where: {
              id: { in: authRows.map((row) => row.id) },
              status: { in: ['PENDING', 'PROCESSING'] },
            },
          }),
          prisma.notificationDelivery.count({
            where: { id: { in: notificationIds }, status: 'PENDING' },
          }),
        ]);
        unfinished = pending.reduce((a, b) => a + b, 0);
        if (unfinished) await delay(100);
      } while (unfinished && performance.now() < deadline);
      const stopped = await stopPair();
      const finalAuth = await prisma.authenticationChallengeDelivery.findMany({
        where: { id: { in: authRows.map((row) => row.id) } },
        orderBy: { id: 'asc' },
      });
      const finalNotifications = await prisma.notificationDelivery.findMany({
        where: { id: { in: notificationIds } },
        orderBy: { id: 'asc' },
      });
      const afterWorkers = await rates();
      const grants = stopped
        .flatMap((item) => item.grants)
        .sort((a, b) => Number(a.now - b.now));
      const oldGate = beforeGate ? persisted(beforeGate) : { n: 0n, d: 1n };
      const finalGate = afterWorkers.find(
        (row) => row.key === MAIL_SUBMISSION_GATE.key,
      );
      const observations = (
        kind: 'auth' | 'notifications',
      ): DeferralObservations => {
        const values = stopped.map((item) => item.deferrals?.[kind]);
        return {
          transitions: values.reduce(
            (sum, item) => sum + (item?.transitions ?? 0),
            0,
          ),
          snapshots: values.reduce(
            (sum, item) => sum + (item?.snapshots ?? 0),
            0,
          ),
          racedReads: values.reduce(
            (sum, item) => sum + (item?.racedReads ?? 0),
            0,
          ),
          invalidSnapshots: values.reduce(
            (sum, item) => sum + (item?.invalidSnapshots ?? 0),
            0,
          ),
          readErrors: values.reduce(
            (sum, item) => sum + (item?.readErrors ?? 1),
            0,
          ),
        };
      };
      const deferrals = {
        auth: observations('auth'),
        notifications: observations('notifications'),
      };
      const authKeys = new Set(authRows.map((row) => row.idempotencyKey)),
        mailKeys = new Set(notificationIds);
      const authCalls = calls.filter((call) => authKeys.has(call.key)),
        notificationCalls = calls.filter((call) => mailKeys.has(call.key));
      checks.sharedGateSpacing =
        grants.length === 8 &&
        grants.every(
          (grant, index) =>
            grant.next === grant.now + 125000n &&
            (index
              ? grant.now >= grants[index - 1].next
              : grant.now * oldGate.d >= oldGate.n),
        );
      checks.sharedGatePersisted =
        !!finalGate &&
        finalGate.tatNumerator.toFixed(0) === grants.at(-1)?.next.toString() &&
        finalGate.tatDenominator.toFixed(0) === '1';
      checks.authSentOnce =
        finalAuth.length === 4 &&
        finalAuth.every(
          (row) =>
            row.status === 'SENT' &&
            row.attemptCount === 1 &&
            row.lastSafeFailureCode === null &&
            row.processingLeaseId === null &&
            authRows.some(
              (before) =>
                before.id === row.id &&
                before.idempotencyKey === row.idempotencyKey &&
                before.challengeId === row.challengeId,
            ),
        );
      checks.notificationsSentOnce =
        finalNotifications.length === 4 &&
        finalNotifications.every(
          (row) =>
            row.status === 'SENT' &&
            row.mailAttemptCount === 1 &&
            row.failureCode === null &&
            row.mailLeaseId === null &&
            row.mailPayload === null &&
            row.mailIv === null &&
            row.mailTag === null &&
            notificationRows.some(
              (before) =>
                before.id === row.id &&
                before.idempotencyKey === row.idempotencyKey &&
                before.recipient === row.recipient &&
                isDeepStrictEqual(before.mailExpiresAt, row.mailExpiresAt) &&
                isDeepStrictEqual(
                  before.retentionExpiresAt,
                  row.retentionExpiresAt,
                ),
            ),
        );
      checks.exactlyEightHttpSubmissions =
        calls.length === 8 &&
        new Set(calls.map((call) => call.key)).size === 8 &&
        authCalls.length === 4 &&
        notificationCalls.length === 4 &&
        calls.every((call) => typeof call.respondedAtMs === 'number') &&
        invalidHttp === 0;
      checks.validPersistedDeferralSnapshots = Object.values(deferrals).every(
        (value) =>
          value.transitions > 0 &&
          value.snapshots > 0 &&
          value.invalidSnapshots === 0 &&
          value.readErrors === 0,
      );
      checks.noAdmissionRecharge =
        isDeepStrictEqual(
          afterEnqueueRates.filter(
            (row) => row.key !== MAIL_SUBMISSION_GATE.key,
          ),
          afterWorkers.filter((row) => row.key !== MAIL_SUBMISSION_GATE.key),
        ) && isDeepStrictEqual(afterEnqueueCooldown, await cooldowns());
      checks.receiptsImmutable = isDeepStrictEqual(
        receiptBefore,
        await prisma.authenticationOperation.findMany({
          where: { id: { in: receiptIds } },
          orderBy: { id: 'asc' },
        }),
      );
      checks.authProofAndLifetimeUnchanged = isDeepStrictEqual(
        proof,
        await Promise.all(
          authRows.map((row) => proofSnapshot(row.challengeId)),
        ),
      );
      scenarios.push({
        name: 'mixed-mail-results',
        auth: {
          sent: finalAuth.filter((row) => row.status === 'SENT').length,
          httpSubmissions: authCalls.length,
          deferrals: deferrals.auth,
          workerStartToProviderResponseMs: distribution(
            authCalls.map((call) => (call.respondedAtMs ?? NaN) - workerStart),
          ),
        },
        notifications: {
          sent: finalNotifications.filter((row) => row.status === 'SENT')
            .length,
          httpSubmissions: notificationCalls.length,
          deferrals: deferrals.notifications,
          workerStartToProviderResponseMs: distribution(
            notificationCalls.map(
              (call) => (call.respondedAtMs ?? NaN) - workerStart,
            ),
          ),
        },
        initialAuthClaimsByProcess: workers.map(
          (worker) => worker.summary.claimedCount,
        ),
        initialNotificationOutcomesByProcess: workers.map((worker) =>
          worker.notifications.map((result) => result.outcome),
        ),
        sharedGateGrants: grants.length,
        checks,
      });
      expect(Object.values(checks).every(Boolean)).toBe(true);
    }
    async function configurationMismatch(
      endpoint: string,
      initial: (identity: string, ip: string) => Input,
    ) {
      if (databaseLifecycle.stateMode !== 'isolated')
        throw new Error('Isolated configuration scenario required.');
      const baseline = ['baseline', 'baseline'] as const;
      const beforeRates = await rates(),
        beforeCooldowns = await cooldowns();
      const inputs = new Map<string, Input>();
      const mainIp = '2001:db8:232::1';
      const input = (label: string, ip = mainIp) =>
        initial(`${runId}-${label}@load.example.edu`, ip);
      const snapshot = async () => ({
        rates: await rates(),
        cooldowns: await cooldowns(),
        subjects: await prisma.authenticationChallengeSubject.findMany({
          orderBy: { key: 'asc' },
        }),
        challenges: await prisma.authenticationChallenge.findMany({
          orderBy: { id: 'asc' },
        }),
        deliveries: await prisma.authenticationChallengeDelivery.findMany({
          orderBy: { id: 'asc' },
        }),
        receipts: await prisma.authenticationOperation.findMany({
          orderBy: { id: 'asc' },
        }),
        backlog: await prisma.authenticationDeliveryBacklogState.findMany(),
        pressure: await prisma.mailProviderPressure.findMany(),
      });
      const counts = (state: Awaited<ReturnType<typeof snapshot>>) => ({
        subjects: state.subjects.length,
        challenges: state.challenges.length,
        deliveries: state.deliveries.length,
        receipts: state.receipts.length,
        rateBuckets: state.rates.length,
        cooldownBuckets: state.cooldowns.length,
      });
      const prepare = async (index: number, value: Input) => {
        const [id] = await pair[index].call<string[]>({
          kind: 'PREPARE',
          requests: [value.request],
        });
        inputs.set(id, value);
        return id;
      };
      const execute = async (index: number) =>
        (await pair[index].call<ReplicaExecution[]>({ kind: 'EXECUTE' }))[0];
      const retry = (index: number, id: string, value: Input) =>
        pair[index].call<ReplicaExecution>({
          kind: 'EXECUTE_OPERATION',
          operationId: id,
          request: value.request,
        });
      const ipKeys = keys(policies.deliveryIp, mainIp);
      const ready = await newPair(endpoint, baseline);
      for (let index = 0; index < 3; index++) {
        await prepare(0, input(`seed-${index}`));
        expect((await execute(0)).response?.result.outcome).toBe('CREATED');
      }
      const seeded = await snapshot();
      const aliases = seeded.rates.filter((row) => ipKeys.includes(row.key));
      expect(aliases).toHaveLength(ipKeys.length);
      expect(
        aliases.every(
          (row) =>
            row.burst === 3n && row.rate === 1n && row.periodSeconds === 3600n,
        ),
      ).toBe(true);
      // Independent rational oracle: ceil(TAT - (burst - 1) * period/rate).
      const eligible = aliases
        .map((row) => {
          const tat = persisted(row);
          const denominator = tat.d * row.rate;
          const numerator =
            tat.n * row.rate -
            (row.burst - 1n) * row.periodSeconds * 1000000n * tat.d;
          return (numerator + denominator - 1n) / denominator;
        })
        .reduce((a, b) => (a > b ? a : b));
      const assertDenial = (execution: ReplicaExecution) => {
        expect(execution.error).toBeUndefined();
        expect(execution.response?.result).toMatchObject({
          outcome: 'DENIED',
          denial: 'RATE_LIMITED',
          deniedPolicyIds: [policies.deliveryIp.id],
        });
        if (execution.response?.result.outcome !== 'DENIED')
          throw new Error('Expected persisted IP debt denial.');
        expect(execution.response.result.retryNotBeforeMicros).toBe(eligible);
        expect(execution.response.result.evaluatedAtMicros < eligible).toBe(
          true,
        );
      };
      const assertOnlyReceiptAdded = (
        before: Awaited<ReturnType<typeof snapshot>>,
        after: Awaited<ReturnType<typeof snapshot>>,
      ) => {
        expect({ ...after, receipts: [] }).toEqual({ ...before, receipts: [] });
        expect(after.receipts).toHaveLength(before.receipts.length + 1);
        for (const row of before.receipts)
          expect(after.receipts.find((item) => item.id === row.id)).toEqual(
            row,
          );
      };
      scenarios.push({
        name: 'exhaust-real-ip-policy',
        processes: ready,
        policy: { burst: 3, rate: 1, periodSeconds: 3600 },
        committedDeliveries: 3,
        checks: {
          debtCreatedByRealAdmissions: true,
          aliasesHaveBaselineSnapshot: true,
        },
      });
      await stopPair();
      const variants = ['burst', 'rate', 'period'] as const;
      for (const [wave, variant] of variants.entries()) {
        const badIndex = wave % 2 === 0 ? 1 : 0;
        const profiles: [ConfigurationProfile, ConfigurationProfile] = [
          'baseline',
          'baseline',
        ];
        profiles[badIndex] = variant;
        const beforeStartup = await snapshot();
        const mixedReady = await newPair(endpoint, profiles);
        expect(await snapshot()).toEqual(beforeStartup);
        const fresh = input(`mismatch-${variant}`);
        const operationId = await prepare(badIndex, fresh);
        const before = await snapshot();
        const failed = await execute(badIndex);
        expect(failed.error).toBe('STATE_UNAVAILABLE');
        expect(failed.response).toBeUndefined();
        const afterFailure = await snapshot();
        expect(afterFailure).toEqual(before);
        expect(
          afterFailure.receipts.some((row) => row.id === operationId),
        ).toBe(false);
        // The correctly configured peer sees a policy denial, never the
        // misconfigured peer's infrastructure failure or a new burst.
        const controlId = await prepare(
          1 - badIndex,
          input(`matched-control-${variant}`),
        );
        const control = await execute(1 - badIndex);
        assertDenial(control);
        const beforeRestart = await snapshot();
        assertOnlyReceiptAdded(afterFailure, beforeRestart);
        expect(
          beforeRestart.receipts.find((row) => row.id === controlId)?.outcome,
        ).toBe('DENIED');
        await stopPair();
        const recovered = await newPair(endpoint, baseline);
        expect(
          recovered.every(
            (replica) => !mixedReady.some((old) => old.pid === replica.pid),
          ),
        ).toBe(true);
        expect(await snapshot()).toEqual(beforeRestart);
        const retried = await retry(badIndex, operationId, fresh);
        assertDenial(retried);
        expect(retried.response?.replayed).toBe(false);
        const afterRetry = await snapshot();
        assertOnlyReceiptAdded(beforeRestart, afterRetry);
        expect(
          afterRetry.receipts.find((row) => row.id === operationId)?.outcome,
        ).toBe('DENIED');
        const replay = await retry(1 - badIndex, operationId, fresh);
        expect(replay.response?.replayed).toBe(true);
        assertDenial(replay);
        expect(await snapshot()).toEqual(afterRetry);
        scenarios.push({
          name: 'policy-mismatch-and-matched-restart',
          changedParameter: variant,
          misconfiguredProcess: badIndex,
          profiles,
          processes: mixedReady,
          recoveredProcesses: recovered,
          technicalFailure: failed.error,
          before: counts(before),
          afterFailure: counts(afterFailure),
          afterRecovery: counts(afterRetry),
          checks: {
            startupDidNotRetune: true,
            technicalFailureNotPolicyDenial: true,
            noPartialWrites: true,
            correctlyConfiguredPeerStillEnforcesDebt: true,
            newProcessesObserved: true,
            restartDidNotResetState: true,
            sameOperationRetriedAsPolicyDenial: true,
            originalRetryBoundaryPreserved: true,
            replayImmutable: true,
          },
        });
        if (wave < variants.length - 1) await stopPair();
      }
      // Positive control: matched processes may still admit an independent IP.
      await prepare(0, input('independent-control', '2001:db8:232::2'));
      expect((await execute(0)).response?.result.outcome).toBe('CREATED');
      const receipts = await prisma.authenticationOperation.findMany();
      const committed = receipts.filter((row) => row.outcome === 'CREATED');
      expect(committed).toHaveLength(4);
      expect(receipts.filter((row) => row.outcome === 'DENIED')).toHaveLength(
        6,
      );
      expect(receipts).toHaveLength(10);
      expect(
        checkAccounting(beforeRates, await rates(), receipts, inputs),
      ).toBe(true);
      expect(
        checkCooldowns(beforeCooldowns, await cooldowns(), receipts, inputs),
      ).toBe(true);
      expect((await rates()).filter((row) => ipKeys.includes(row.key))).toEqual(
        aliases,
      );
      const drained = await drainDeliveries(
        committed.map((row) => row.deliveryId!),
      );
      expect(
        drained.final.every(
          (row) => row.status === 'SENT' && row.attemptCount === 1,
        ),
      ).toBe(true);
      expect(drained.final).toHaveLength(4);
      expect(drained.submissions).toHaveLength(4);
      scenarios.push({
        name: 'independent-control-and-delivery-drain',
        createdReceipts: 4,
        deniedReceipts: 6,
        technicalFailuresWithoutReceipts: 3,
        sent: drained.final.length,
        httpSubmissions: drained.submissions.length,
        checks: {
          noFreshBurst: true,
          noChargeForTechnicalFailuresOrDenials: true,
          originalIpDebtUnchanged: true,
          exactCommittedCharges: true,
          independentIpStillAllowed: true,
          allCreatedSentOnce: true,
        },
      });
    }
    async function rollbackAndCleanup(
      endpoint: string,
      initial: (identity: string, ip: string) => Input,
    ) {
      if (databaseLifecycle.stateMode !== 'isolated')
        throw new Error('Isolated rollback scenario required.');
      const ready = await newPair(endpoint);
      const beforeRates = await rates(),
        beforeCooldowns = await cooldowns();
      const inputs = new Map<string, Input>();
      const ip = '2001:db8:23::1';
      const fixture = (label: string) =>
        initial(`${runId}-${label}@load.example.edu`, ip);
      const snapshot = async () => ({
        rates: await rates(),
        cooldowns: await cooldowns(),
        subjects: await prisma.authenticationChallengeSubject.findMany({
          orderBy: { key: 'asc' },
        }),
        challenges: await prisma.authenticationChallenge.findMany({
          orderBy: { id: 'asc' },
        }),
        deliveries: await prisma.authenticationChallengeDelivery.findMany({
          orderBy: { id: 'asc' },
        }),
        receipts: await prisma.authenticationOperation.findMany({
          orderBy: { id: 'asc' },
        }),
        backlog: await prisma.authenticationDeliveryBacklogState.findMany(),
      });
      const counts = (state: Awaited<ReturnType<typeof snapshot>>) => ({
        subjects: state.subjects.length,
        challenges: state.challenges.length,
        deliveries: state.deliveries.length,
        receipts: state.receipts.length,
        rateBuckets: state.rates.length,
        cooldownBuckets: state.cooldowns.length,
      });
      const prepare = async (index: number, input: Input) => {
        const [id] = await pair[index].call<string[]>({
          kind: 'PREPARE',
          requests: [input.request],
        });
        inputs.set(id, input);
        return id;
      };
      const execute = async (index: number) =>
        (await pair[index].call<ReplicaExecution[]>({ kind: 'EXECUTE' }))[0];
      const retry = (index: number, id: string, input: Input) =>
        pair[index].call<ReplicaExecution>({
          kind: 'EXECUTE_OPERATION',
          operationId: id,
          request: input.request,
        });
      const cleanup = (index: number) =>
        pair[index].call<ReplicaCleanup>({ kind: 'CLEANUP' });
      const emptyCleanup = {
        clearedProof: 0,
        deletedDelivery: 0,
        deletedChallenge: 0,
        deletedSubject: 0,
        deletedReceipt: 0,
      };
      const control = fixture('control');
      const controlId = await prepare(0, control);
      const controlResult = await execute(0);
      expect(controlResult.response?.result.outcome).toBe('CREATED');
      const schema = `rollback_${randomUUID().replaceAll('-', '')}`;
      const trigger = `${schema}_trigger`;
      const barrier = BigInt.asIntN(
        64,
        BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 16)}`),
      );
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      try {
        await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${schema}".hits`);
        // Reaching the sequence proves that the real transaction already wrote
        // challenge, Delivery, identity quota and cooldown before the fault/wait.
        await prisma.$executeRawUnsafe(`CREATE FUNCTION "${schema}".receipt_barrier() RETURNS trigger LANGUAGE plpgsql AS $test$
          BEGIN
            IF NEW."id"::text <> TG_ARGV[0] THEN RETURN NEW; END IF;
            IF NEW."outcome" <> 'CREATED'
              OR NOT EXISTS (SELECT 1 FROM "AuthenticationChallenge" WHERE id=NEW."challengeId")
              OR NOT EXISTS (SELECT 1 FROM "AuthenticationChallengeDelivery" WHERE id=NEW."deliveryId" AND "challengeId"=NEW."challengeId")
              OR NOT EXISTS (SELECT 1 FROM "GcraRateLimit" WHERE key=TG_ARGV[2])
              OR NOT EXISTS (SELECT 1 FROM "AuthenticationRateLimit" WHERE key=TG_ARGV[3])
            THEN RAISE EXCEPTION 'Invalid test fault point.' USING ERRCODE='22000'; END IF;
            PERFORM nextval('"${schema}".hits');
            IF TG_ARGV[1]='fail' THEN RAISE EXCEPTION 'Injected confirmed receipt abort.' USING ERRCODE='23514'; END IF;
            PERFORM pg_advisory_xact_lock(${barrier.toString()}::bigint);
            RETURN NEW;
          END $test$`);
        const hits = async () => {
          const [row] = await prisma.$queryRawUnsafe<{ count: string }[]>(
            `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS count FROM "${schema}".hits`,
          );
          return Number(row.count);
        };
        const install = async (
          id: string,
          mode: 'fail' | 'hold',
          input: Input,
        ) => {
          const quota = keys(policies.deliveryIdentity, input.identity)[0];
          const cooldown = keys(
            policies.identityDeliveryCooldown,
            input.identity,
          )[0];
          if (
            !/^[a-f0-9-]{36}$/.test(id) ||
            ![quota, cooldown].every((key) =>
              /^rl:v1:k[1-9][0-9]*:[a-f0-9]{64}$/.test(key),
            )
          )
            throw new Error('Invalid locally generated test arguments.');
          await prisma.$executeRawUnsafe(
            `CREATE TRIGGER "${trigger}" BEFORE INSERT ON "AuthenticationOperation" FOR EACH ROW EXECUTE FUNCTION "${schema}".receipt_barrier('${id}', '${mode}', '${quota}', '${cooldown}')`,
          );
        };
        const uninstall = () =>
          prisma.$executeRawUnsafe(
            `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationOperation"`,
          );
        for (const index of [0, 1]) {
          const input = fixture(`fault-${index}`);
          const id = await prepare(index, input);
          const before = await snapshot(),
            beforeHits = await hits();
          await install(id, 'fail', input);
          let failed: ReplicaExecution;
          try {
            failed = await execute(index);
          } finally {
            await uninstall();
          }
          expect(failed.error).toBe('STATE_UNAVAILABLE');
          expect(await hits()).toBe(beforeHits + 1);
          const afterAbort = await snapshot();
          expect(afterAbort).toEqual(before);
          const accepted = await retry(1 - index, id, input);
          expect(accepted.response?.result.outcome).toBe('CREATED');
          expect(accepted.response?.replayed).toBe(false);
          const committed = await snapshot();
          const replay = await retry(index, id, input);
          expect(replay.response?.replayed).toBe(true);
          expect(await snapshot()).toEqual(committed);
          scenarios.push({
            name: 'confirmed-abort-and-cross-process-retry',
            failingProcess: index,
            retryProcess: 1 - index,
            faultPoint:
              'real receipt INSERT after admission writes; SQLSTATE 23514',
            before: counts(before),
            afterAbort: counts(afterAbort),
            afterRetry: counts(committed),
            checks: {
              faultReachedOnce: true,
              completeRollback: true,
              authoritativeFailure: true,
              retryCreatedOnce: true,
              replayImmutable: true,
            },
          });
        }

        const racing = fixture('cleanup-race');
        const subjectKey = randomUUID();
        await prisma.authenticationChallengeSubject.create({
          data: {
            key: subjectKey,
            normalizedIdentity: racing.identity,
            purpose: 'SIGN_IN',
          },
        });
        const racingId = await prepare(0, racing);
        await install(racingId, 'hold', racing);
        let release!: () => void, announce!: (pid: number) => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const announced = new Promise<number>((resolve) => {
          announce = resolve;
        });
        const holding = prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(${barrier})`;
            const [row] = await tx.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS pid`;
            announce(row.pid);
            await released;
          },
          { timeout: 10000 },
        );
        // Attach rejection handlers immediately while the test coordinates the barrier.
        void holding.catch(() => {});
        let pending: Promise<ReplicaExecution[]> | undefined;
        let observedWait = false;
        let during!: ReplicaCleanup;
        try {
          const blocker = await Promise.race([
            announced,
            holding.then(() => {
              throw new Error('Barrier ended before ready.');
            }),
          ]);
          pending = pair[0].call<ReplicaExecution[]>({ kind: 'EXECUTE' });
          void pending.catch(() => {});
          const deadline = performance.now() + 3000;
          do {
            const [row] = await prisma.$queryRaw<
              { waiting: boolean }[]
            >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND ${blocker}::int=ANY(pg_blocking_pids(pid))) AS waiting`;
            observedWait = row.waiting;
            if (!observedWait) await delay(10);
          } while (!observedWait && performance.now() < deadline);
          expect(observedWait).toBe(true);
          during = await cleanup(1);
          expect(during).toEqual(emptyCleanup);
          expect(
            await prisma.authenticationChallengeSubject.count({
              where: { key: subjectKey },
            }),
          ).toBe(1);
          release();
          await holding;
          expect((await pending)[0].response?.result.outcome).toBe('CREATED');
        } finally {
          release();
          await Promise.allSettled(pending ? [holding, pending] : [holding]);
          await uninstall();
        }
        const afterCommit = await snapshot();
        expect(await cleanup(1)).toEqual(emptyCleanup);
        expect(await snapshot()).toEqual(afterCommit);
        scenarios.push({
          name: 'cleanup-during-admission',
          processes: ready,
          observedDatabaseBarrierWait: observedWait,
          deletedWhileSubjectLocked: during.deletedSubject,
          checks: {
            lockedSubjectSkipped: true,
            activeChildRetainedAfterCommit: true,
            activeProofAndStateImmutable: true,
          },
        });
      } finally {
        await prisma.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS "${trigger}" ON "AuthenticationOperation"`,
        );
        await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }

      const receipts = await prisma.authenticationOperation.findMany({
        where: { id: { in: [...inputs.keys()] } },
      });
      expect(receipts).toHaveLength(4);
      expect(
        checkAccounting(beforeRates, await rates(), receipts, inputs),
      ).toBe(true);
      expect(
        checkCooldowns(beforeCooldowns, await cooldowns(), receipts, inputs),
      ).toBe(true);
      const drained = await drainDeliveries(
        receipts.map((row) => row.deliveryId!),
      );
      expect(drained.final).toHaveLength(4);
      expect(
        drained.final.every(
          (row) => row.status === 'SENT' && row.attemptCount === 1,
        ),
      ).toBe(true);
      expect(drained.submissions).toHaveLength(4);
      await newPair(endpoint);
      const activeRates = await rates(),
        activeCooldowns = await cooldowns();
      const controlReceipt = receipts.find((row) => row.id === controlId)!;
      const remaining = await prisma.authenticationChallenge.findMany({
        where: { id: { not: controlReceipt.challengeId! } },
        orderBy: { id: 'asc' },
      });
      // Historical retention fixtures only. Never rewind a policy clock or edit
      // active GCRA/cooldown rows. Receipt windows remain unchanged and live.
      await prisma.$executeRaw`UPDATE "AuthenticationChallenge" SET "expiresAt"=clock_timestamp()-INTERVAL '2 seconds', "retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE id=${controlReceipt.challengeId}`;
      await prisma.$executeRaw`UPDATE "AuthenticationChallengeDelivery" SET "retentionExpiresAt"=clock_timestamp()-INTERVAL '1 second' WHERE id=${controlReceipt.deliveryId}`;
      const deleted = await cleanup(1);
      expect(deleted).toEqual({
        clearedProof: 1,
        deletedDelivery: 1,
        deletedChallenge: 1,
        deletedSubject: 1,
        deletedReceipt: 0,
      });
      expect(await rates()).toEqual(activeRates);
      expect(await cooldowns()).toEqual(activeCooldowns);
      expect(
        await prisma.authenticationChallenge.findMany({
          orderBy: { id: 'asc' },
        }),
      ).toEqual(remaining);
      expect(await prisma.authenticationOperation.count()).toBe(4);
      const beforeDenied = await snapshot();
      const deniedId = await prepare(0, control);
      const denial = await execute(0);
      expect(denial.response?.result).toMatchObject({
        outcome: 'DENIED',
        denial: 'RATE_LIMITED',
        deniedPolicyIds: [policies.identityDeliveryCooldown.id],
      });
      const identityKeys = keys(
        policies.identityDeliveryCooldown,
        control.identity,
      );
      const boundaries = activeCooldowns
        .filter((row) => identityKeys.includes(row.key))
        .map((row) => BigInt(row.boundary));
      expect(boundaries).toHaveLength(identityKeys.length);
      const originalBoundary = boundaries.reduce((a, b) => (a > b ? a : b));
      if (denial.response?.result.outcome !== 'DENIED')
        throw new Error('Expected retained identity cooldown denial.');
      expect(denial.response.result.retryNotBeforeMicros).toBe(
        originalBoundary,
      );
      expect(denial.response.result.evaluatedAtMicros < originalBoundary).toBe(
        true,
      );
      const afterDenied = await snapshot();
      expect({ ...afterDenied, receipts: [] }).toEqual({
        ...beforeDenied,
        receipts: [],
      });
      expect(afterDenied.receipts).toHaveLength(5);
      expect(
        afterDenied.receipts.find((row) => row.id === deniedId)?.outcome,
      ).toBe('DENIED');
      expect(
        checkAccounting(
          beforeRates,
          afterDenied.rates,
          afterDenied.receipts,
          inputs,
        ),
      ).toBe(true);
      expect(
        checkCooldowns(
          beforeCooldowns,
          afterDenied.cooldowns,
          afterDenied.receipts,
          inputs,
        ),
      ).toBe(true);
      scenarios.push({
        name: 'retention-without-admission-refund',
        deleted,
        committedDeliveriesBeforeCleanup: 4,
        providerSubmissions: drained.submissions.length,
        checks: {
          exactCommittedCharges: true,
          terminalDeliveriesSentOnce: true,
          retainedRowsRemoved: true,
          unexpiredReceiptsPreserved: true,
          activeProofUnchanged: true,
          debtAndCooldownUnchanged: true,
          reentryDeniedByOriginalIdentityCooldown: true,
          denialHasNoPartialMutation: true,
        },
      });
    }
    try {
      await prisma.$connect();
      const [authPending, notificationPending] = await Promise.all([
        prisma.authenticationChallengeDelivery.count({
          where: { status: { in: ['PENDING', 'PROCESSING'] } },
        }),
        prisma.notificationDelivery.count({ where: { status: 'PENDING' } }),
      ]);
      if (authPending || notificationPending)
        throw new Error('Inspect unfinished stand work before rerunning.');
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const initial = (identity: string, ip: string): Input => ({
        identity,
        ip,
        request: {
          kind: 'SIGN_IN_REQUEST',
          input: {
            normalizedIdentity: identity,
            ipAddress: ip,
            templateProtocolVersion: 1,
          },
        },
      });
      if (configMismatch) {
        await configurationMismatch(endpoint, initial);
      } else if (rollbackCleanup) {
        await rollbackAndCleanup(endpoint, initial);
      } else if (mixedMail) {
        await mixMail(endpoint, initial);
      } else if (sharedIp) {
        await shareIp(endpoint, initial);
      } else if (isolation) {
        await isolateIdentity(endpoint, initial);
      } else {
        const distinct = Array.from({ length: 8 }, (_, index) =>
          initial(
            `${runId}-${index}@load.example.edu`,
            `2001:db8:1::${index + 1}`,
          ),
        );
        await phase(
          'distinct-identities',
          distinct,
          8,
          undefined,
          await newPair(endpoint),
        );
        const identity = `${runId}-same@load.example.edu`,
          ip = '2001:db8:2::1';
        const same = Array.from({ length: 8 }, () => initial(identity, ip));
        const first = await phase(
          'same-identity-initial',
          same,
          1,
          'REUSED',
          await newPair(endpoint),
        );
        const cooldownKeys = [
          ...keys(policies.challengeDeliveryCooldown, first.challengeId),
          ...keys(policies.identityDeliveryCooldown, identity),
        ];
        const boundaries = (await cooldowns())
          .filter((row) => cooldownKeys.includes(row.key))
          .map((row) => BigInt(row.boundary));
        expect(boundaries.length).toBe(cooldownKeys.length);
        const boundary = boundaries.reduce((a, b) => (a > b ? a : b));
        const waitStart = performance.now();
        let remaining: bigint;
        do {
          remaining = boundary - (await now());
          if (remaining > 0n)
            await delay(Math.min(500, Number((remaining + 999n) / 1000n)));
        } while (remaining > 0n && performance.now() - waitStart < 65000);
        expect(remaining <= 0n).toBe(true);
        const waitedMs = performance.now() - waitStart;
        const challenge =
          await prisma.authenticationChallenge.findUniqueOrThrow({
            where: { id: first.challengeId },
          });
        const resend: Input[] = Array.from({ length: 8 }, () => ({
          identity,
          ip,
          request: {
            kind: 'RESEND',
            input: {
              challengeId: first.challengeId,
              ipAddress: ip,
              templateProtocolVersion: 1,
              retentionExpiresAt: challenge.retentionExpiresAt,
            },
          },
        }));
        const last = await phase(
          'same-challenge-resend',
          resend,
          1,
          'EXISTING',
          await newPair(endpoint),
        );
        last.checks.stableAcrossResend =
          isDeepStrictEqual(first.proof, last.proof) &&
          first.initialDigest === last.initialDigest;
        last.checks.cooldownElapsedOnDatabaseClock = remaining <= 0n;
        expect(last.checks.stableAcrossResend).toBe(true);
        scenarios.push({
          name: 'cooldown-wait',
          waitedMs,
          basis: 'persisted cooldown boundaries and PostgreSQL clock; no reset',
        });
      }
      passed = true;
    } finally {
      const cleanup = await Promise.allSettled(pair.map((item) => item.stop()));
      if (cleanup.some((item) => item.status === 'rejected')) passed = false;
      await prisma.$disconnect();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      const report = {
        schemaVersion: 2,
        databaseLifecycle,
        scenario: configMismatch
          ? 'internal-auth-configuration-mismatch'
          : rollbackCleanup
            ? 'internal-auth-rollback-and-cleanup'
            : mixedMail
              ? 'internal-auth-and-notification-shared-gate'
              : sharedIp
                ? 'internal-auth-shared-ip-budget'
                : isolation
                  ? 'internal-auth-identity-cooldown-isolation'
                  : 'internal-auth-two-process-concurrency',
        runId,
        recordedAt: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: resolve(__dirname, '../..'),
          encoding: 'utf8',
        }).trim(),
        worktreeDirty:
          execFileSync('git', ['status', '--porcelain'], {
            cwd: resolve(__dirname, '../..'),
            encoding: 'utf8',
          }).length > 0,
        processes: {
          maxConcurrentReplicas: 2,
          launchedPids: launched,
          observerPid: process.pid,
        },
        scenarios,
        elapsedMs: performance.now() - start,
        passed,
        limitations: [
          'Internal services after email/domain eligibility; not public HTTP or mailbox delivery.',
          'Two local OS processes share host resources; no production capacity or fairness claim.',
          'Always-200 fake provider; process/network faults and commit ambiguity are later work.',
          configMismatch
            ? 'Active IP-policy snapshot mismatch and matched restarts only; no retuning, key rotation or fleet-wide configuration consensus.'
            : rollbackCleanup
              ? 'Confirmed receipt aborts and existing entity cleanup only; no GCRA/cooldown bucket garbage collector is implemented or tested.'
              : 'No configuration/key rotation, cleanup or provider-fault scenarios in this command.',
          ...(mixedMail
            ? [
                'Deferral observers add DB reads; these timings do not establish capacity or queue fairness.',
                'Response latency is from parent dispatch of worker startup to fake-provider response emission, including IPC and test coordination.',
              ]
            : ['Notification competition is not exercised by this command.']),
          'Personal identity GCRA exhaustion and heavy traffic are not exercised.',
          ...(sharedIp || configMismatch
            ? [
                'Shared-IP values are experimental fixtures, not production sizing.',
              ]
            : ['Shared-IP saturation is not exercised by this command.']),
          databaseLifecycle.stateMode === 'retained'
            ? 'Active state and fixture data are retained; no reset or refund.'
            : 'One fresh template copy shared by every stage and process; no reset/refund during the scenario.',
        ],
      };
      await writeFile(
        process.env.LOAD_REPORT_PATH,
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(JSON.stringify(report));
    }
    expect(passed).toBe(true);
  });
});
