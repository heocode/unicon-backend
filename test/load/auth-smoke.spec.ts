import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationDeliveryWorkerService } from '../../src/auth/delivery/services/authentication-delivery-worker.service';
import { AuthenticationOperationError } from '../../src/auth/operations/errors/authentication-operation.error';
import { AuthenticationOperationService } from '../../src/auth/operations/services/authentication-operation.service';
import { validateEnvironment } from '../../src/config/environment.validation';
import { ResendMailHttpClient } from '../../src/mail/services/resend-mail-http-client.service';
import type { MailSubmission } from '../../src/mail/types/mail-submission.type';
import { PrismaService } from '../../src/prisma/prisma.service';
import { boundedInteger, distribution, offerLoad } from './load-utils';
import { loadDatabaseRuntime } from '../utils/test-database-runtime';

// Opt-in, bounded instrumentation stand. Not part of regular unit/e2e discovery.
describe('Stage 4 Iteration 7 internal load smoke', () => {
  jest.setTimeout(120000);

  it('records real admission, scheduled worker, gate and local provider outcomes', async () => {
    const databaseLifecycle = loadDatabaseRuntime();
    if (!process.env.LOAD_REPORT_PATH)
      throw new Error('Load report path required.');

    const rate = boundedInteger(process.env.LOAD_RATE, 2, 20);
    const durationSeconds = boundedInteger(
      process.env.LOAD_DURATION_SECONDS,
      3,
      10,
    );
    const providerDelayMs = boundedInteger(
      process.env.LOAD_PROVIDER_DELAY_MS,
      25,
      2000,
    );
    const drainSeconds = boundedInteger(process.env.LOAD_DRAIN_SECONDS, 15, 60);
    const count = rate * durationSeconds;
    if (count > 100)
      throw new Error('Smoke stand supports at most 100 arrivals.');

    let module: TestingModule | undefined;
    let startedWorker = false;
    let monitoring: Promise<void> | undefined;
    let stopMonitoring = false;
    const providerCallsMs: number[] = [];
    const providerKeys = new Set<string>();
    const acceptedAt = new Map<string, number>();
    let invalidProviderRequests = 0;
    let providerRequests = 0;
    const provider = createServer((request, response) => {
      // Drain and discard bodies: never retain proof, recipients or payloads.
      request.resume();
      request.on('end', () => {
        const key = request.headers['idempotency-key'];
        if (
          request.method !== 'POST' ||
          request.url !== '/emails' ||
          typeof key !== 'string'
        ) {
          invalidProviderRequests++;
          response.writeHead(400).end();
          return;
        }
        providerRequests++;
        providerKeys.add(key);
        void delay(providerDelayMs).then(() => {
          acceptedAt.set(key, performance.now());
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: 'load-smoke-accepted' }));
        });
      });
    });
    const runId = randomUUID();
    const starts = new Map<string, number>();
    const admissionMs: number[] = [];
    const outcomes: Record<string, number> = {};
    const errors: Record<string, number> = {};
    const queue: {
      elapsedMs: number;
      outstanding: number;
      oldestAgeMs: number;
    }[] = [];
    const deliveryIds: string[] = [];
    try {
      await new Promise<void>((done) => provider.listen(0, '127.0.0.1', done));
      const endpoint = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/emails`;
      class LocalClient extends ResendMailHttpClient {
        protected readonly endpoint = endpoint;
        override async send(submission: MailSubmission, signal: AbortSignal) {
          const start = performance.now();
          try {
            return await super.send(submission, signal);
          } finally {
            providerCallsMs.push(performance.now() - start);
          }
        }
      }
      module = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            validate: validateEnvironment,
          }),
          AuthModule,
        ],
      })
        .overrideProvider(ResendMailHttpClient)
        .useClass(LocalClient)
        .compile();
      const prisma = module.get(PrismaService);
      // Never process pending leftovers from another run. No data/debt reset.
      const [authPending, mailPending] = await Promise.all([
        prisma.authenticationChallengeDelivery.count({
          where: { status: { in: ['PENDING', 'PROCESSING'] } },
        }),
        prisma.notificationDelivery.count({
          where: { status: 'PENDING' },
        }),
      ]);
      if (authPending || mailPending)
        throw new Error(
          'Dedicated stand has unfinished work; inspect it before another run.',
        );
      const config = module.get(ConfigService);
      const settings = Object.fromEntries(
        [
          'AUTH_DELIVERY_GLOBAL_BURST',
          'AUTH_DELIVERY_GLOBAL_RATE',
          'AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS',
          'AUTH_DELIVERY_BACKLOG_LIMIT',
          'AUTH_DELIVERY_WORKER_INTERVAL_SECONDS',
          'AUTH_DELIVERY_WORKER_CONCURRENCY',
          'AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE',
          'AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS',
          'AUTH_DELIVERY_RETRY_BACKOFF_SECONDS',
          'AUTH_DELIVERY_RETRY_JITTER_PERCENT',
          'AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS',
          'AUTH_DELIVERY_PROCESSING_LEASE_SECONDS',
          'AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS',
          'AUTH_CHALLENGE_TTL_SECONDS',
          'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
          'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
          'AUTH_DELIVERY_IDENTITY_BURST',
          'AUTH_DELIVERY_IDENTITY_RATE',
          'AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS',
          'AUTH_DELIVERY_IP_BURST',
          'AUTH_DELIVERY_IP_RATE',
          'AUTH_DELIVERY_IP_PERIOD_SECONDS',
          'MAIL_RESEND_SUBMISSIONS_PER_SECOND',
          'MAIL_RESEND_TEAM_REQUESTS_PER_SECOND',
          'RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS',
          'RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS',
          'RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS',
        ].map((key) => [key, config.getOrThrow<unknown>(key)]),
      );
      const [pg] = await prisma.$queryRaw<
        { version: string }[]
      >`SELECT version() AS version`;
      const operations = module.get(AuthenticationOperationService);
      const worker = module.get(AuthenticationDeliveryWorkerService);
      // Start only the real auth worker scheduler. No full app init, no unrelated
      // cleanup/notification jobs. Compile alone does not run lifecycle hooks.
      worker.onModuleInit();
      startedWorker = true;
      const runStart = performance.now();
      monitoring = (async () => {
        while (!stopMonitoring) {
          const [sample] = await prisma.$queryRaw<
            { outstanding: number; oldestAgeMs: number }[]
          >`
            SELECT count(*)::int AS outstanding,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp() - min("createdAt"))) * 1000, 0)::float8 AS "oldestAgeMs"
            FROM "AuthenticationChallengeDelivery" WHERE status IN ('PENDING', 'PROCESSING')`;
          queue.push({ elapsedMs: performance.now() - runStart, ...sample });
          await delay(100);
        }
      })();
      // Attach a handler immediately; report monitor failure after producers stop.
      void monitoring.catch(() => {
        stopMonitoring = true;
      });
      const offered = await offerLoad(rate, count, async (index, started) => {
        try {
          const id = await operations.createOperationId();
          const { result } = await operations.execute(id, {
            kind: 'SIGN_IN_REQUEST',
            input: {
              normalizedIdentity: `${runId}-${index}@load.example.edu`,
              ipAddress: `2001:db8::${(index + 1).toString(16)}`,
              templateProtocolVersion: 1,
            },
          });
          const label =
            result.outcome === 'DENIED' ? result.denial : result.outcome;
          outcomes[label] = (outcomes[label] ?? 0) + 1;
          if (result.outcome === 'CREATED') {
            deliveryIds.push(result.deliveryId);
            starts.set(result.deliveryId, started);
          }
        } catch (error) {
          const label =
            error instanceof AuthenticationOperationError
              ? error.reason
              : 'UNEXPECTED';
          errors[label] = (errors[label] ?? 0) + 1;
        } finally {
          admissionMs.push(performance.now() - started);
        }
      });
      const producersDone = performance.now();
      const drainDeadline = producersDone + drainSeconds * 1000;
      let pending: number;
      do {
        pending = await prisma.authenticationChallengeDelivery.count({
          where: {
            id: { in: deliveryIds },
            status: { in: ['PENDING', 'PROCESSING'] },
          },
        });
        if (pending) await delay(100);
      } while (pending && performance.now() < drainDeadline);
      await worker.onModuleDestroy();
      startedWorker = false;
      stopMonitoring = true;
      await monitoring;
      const deliveries = await prisma.authenticationChallengeDelivery.findMany({
        where: { id: { in: deliveryIds } },
        select: {
          id: true,
          status: true,
          attemptCount: true,
          idempotencyKey: true,
        },
      });
      const statuses: Record<string, number> = {};
      const endToEndMs: number[] = [];
      for (const item of deliveries) {
        statuses[item.status] = (statuses[item.status] ?? 0) + 1;
        const accepted = acceptedAt.get(item.idempotencyKey);
        const started = starts.get(item.id);
        if (accepted !== undefined && started !== undefined)
          endToEndMs.push(accepted - started);
      }
      const checks = {
        generatorKeptPace:
          (offered.schedulingLagMs.max ?? Infinity) < 1000 / rate,
        allArrivalsAccounted:
          Object.values(outcomes).reduce((a, b) => a + b, 0) +
            Object.values(errors).reduce((a, b) => a + b, 0) ===
          count,
        noOperationErrors:
          Object.keys(errors).length === 0 && offered.rejectedOperations === 0,
        allCreatedSent:
          deliveries.length === (outcomes.CREATED ?? 0) &&
          deliveries.every((item) => item.status === 'SENT'),
        oneAttemptPerCreatedDelivery: deliveries.every(
          (item) => item.attemptCount === 1,
        ),
        providerMatchesCreated:
          providerRequests === deliveries.length &&
          providerKeys.size === deliveries.length &&
          endToEndMs.length === deliveries.length &&
          invalidProviderRequests === 0,
        someWorkCreated: deliveries.length > 0,
      };
      const report = {
        schemaVersion: 2,
        databaseLifecycle,
        scenario: 'internal-auth-distinct-identities-smoke',
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
        boundary:
          'internal operation entry (includes operation ID creation) to fake-provider response emission; not public HTTP or mailbox arrival',
        environment: {
          platform: platform(),
          node: process.version,
          logicalCpus: cpus().length,
          hostMemoryBytes: totalmem(),
          postgres: pg.version,
          replicas: 1,
          generatorColocated: true,
          resourceNote:
            'Host resources, not container limits or future production capacity.',
        },
        settings,
        workload: {
          rate,
          durationSeconds,
          count,
          providerDelayMs,
          drainSeconds,
          identityPattern: 'distinct',
          ipPattern: 'distinct documentation IPv6 addresses',
          provider: 'loopback HTTP, always 200',
        },
        arrivals: offered,
        outcomes,
        errors,
        deliveryStatuses: statuses,
        latencyMs: {
          operation: distribution(admissionMs),
          providerHttp: distribution(providerCallsMs),
          operationToProviderResponse: distribution(endToEndMs),
        },
        providerRequests,
        observedRunMs: performance.now() - runStart,
        completedDeliveriesPerSecond:
          (statuses.SENT ?? 0) / ((performance.now() - runStart) / 1000),
        drainObservedMs: performance.now() - producersDone,
        backlog: {
          samplingIntervalMs: 100,
          peakSampled: Math.max(0, ...queue.map((item) => item.outstanding)),
          oldestSampledAgeMs: Math.max(
            0,
            ...queue.map((item) => item.oldestAgeMs),
          ),
          finalOutstanding: deliveries.filter((item) =>
            ['PENDING', 'PROCESSING'].includes(item.status),
          ).length,
          samples: queue,
        },
        checks,
        passed: Object.values(checks).every(Boolean),
        limitations: [
          'Small sample; percentiles are descriptive, not SLO evidence.',
          'One process and colocated generator/provider; no capacity conclusion.',
          'Worker and gate waits are not individually instrumented.',
          databaseLifecycle.stateMode === 'retained'
            ? 'Existing debt/provider-pressure state is retained between runs.'
            : 'Fresh template copy; no debt from prior runs; shared PostgreSQL caches are not reset.',
          'No public HTTP/domain eligibility boundary, real mailbox, faults or competing notifications exercised.',
        ],
      };
      await writeFile(
        process.env.LOAD_REPORT_PATH,
        JSON.stringify(report, null, 2) + '\n',
      );
      console.log(
        JSON.stringify({
          scenario: report.scenario,
          outcomes,
          errors,
          deliveryStatuses: statuses,
          latencyMs: report.latencyMs,
          checks,
        }),
      );
      expect(report.passed).toBe(true);
    } finally {
      stopMonitoring = true;
      if (startedWorker)
        await module
          ?.get(AuthenticationDeliveryWorkerService)
          .onModuleDestroy();
      await monitoring?.catch(() => undefined);
      await module?.close();
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
    }
  });
});
