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
import { PrismaService } from '../../src/prisma/prisma.service';
import { RateLimitBucketKeyService } from '../../src/rate-limit/services/rate-limit-bucket-key.service';
import { ConcurrencyProcess } from './concurrency-process';
import type {
  ReplicaExecution,
  ReplicaReady,
  ReplicaStopped,
  ReplicaWorkerStarted,
} from './concurrency-protocol';
import { distribution } from './load-utils';

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
const testName = isolation
  ? 'preserves personal cooldown and independent admission during repeated initial/resend traffic'
  : 'shares admission, stable challenge/resend and scheduled delivery across two processes';
describe(`Stage 4 Iteration 7 ${isolation ? 'block 2.2: identity isolation' : 'block 2.1: two OS processes'}`, () => {
  jest.setTimeout(180000);

  it(testName, async () => {
    if (
      !process.env.LOAD_REPLICA_PATH ||
      !process.env.LOAD_REPORT_PATH ||
      process.env.DOTENV_CONFIG_PATH !== '/dev/null'
    )
      throw new Error('Use npm run test:load:concurrency.');
    const url = new URL(process.env.TEST_DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.port !== '5433' ||
      url.pathname !== '/unicon_load_test' ||
      url.username !== 'unicon_e2e' ||
      url.search ||
      url.hash ||
      process.env.DATABASE_URL !== url.toString()
    )
      throw new Error('Dedicated local stand database required.');
    const config = new ConfigService(validateEnvironment({ ...process.env }));
    const prisma = new PrismaService(config);
    const derivation = new RateLimitBucketKeyService(config);
    const keys = (
      policy: (typeof policies)[keyof typeof policies],
      value: string,
    ) => derivation.deriveKeys(policy, value).buckets.map((item) => item.key);
    const calls: { key: string; digest: string; replica: number }[] = [];
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
        calls.push({
          key,
          digest: hash.digest('hex'),
          replica: Number(match[1]),
        });
        void delay(100).then(() => {
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
    async function newPair(endpoint: string) {
      pair = [0, 1].map(
        (index) => new ConcurrencyProcess(`${endpoint}/emails/${index}`),
      );
      const ready = await Promise.all(pair.map((item) => item.ready));
      expect(
        ready[0].pid !== ready[1].pid &&
          ready.every((item) => item.pid !== process.pid),
      ).toBe(true);
      expect(isDeepStrictEqual(ready[0].settings, ready[1].settings)).toBe(
        true,
      );
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
      await Promise.all(
        pair.map((item) =>
          item.call<ReplicaWorkerStarted>({ kind: 'START_WORKER' }),
        ),
      );
      const deadline = performance.now() + 20000;
      let pending: number;
      do {
        pending = await prisma.authenticationChallengeDelivery.count({
          where: {
            id: { in: normalDeliveryIds },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
        });
        if (pending) await delay(100);
      } while (pending && performance.now() < deadline);
      const stopped = await stopPair();
      const final = await prisma.authenticationChallengeDelivery.findMany({
        where: { id: { in: normalDeliveryIds } },
      });
      const submissions = calls.slice(previousCalls),
        afterWorkers = await rates();
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
      if (isolation) {
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
        schemaVersion: 1,
        scenario: isolation
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
          'No shared-IP exhaustion, notifications, configuration/key rotation or cleanup scenarios in this command.',
          'Personal GCRA exhaustion and heavy traffic are not exercised by the identity-cooldown scenario.',
          'Active state and fixture data are retained; no reset or refund.',
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
