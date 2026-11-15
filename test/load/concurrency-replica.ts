import '../setup-env';
import './setup';

import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { performance } from 'node:perf_hooks';

import { loadDatabaseRuntime } from '../utils/test-database-runtime';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationDeliveryWorkerService } from '../../src/auth/delivery/services/authentication-delivery-worker.service';
import { AuthenticationDeliveryRepository } from '../../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationOperationError } from '../../src/auth/operations/errors/authentication-operation.error';
import { AuthenticationOperationService } from '../../src/auth/operations/services/authentication-operation.service';
import { AuthenticationOperationRepository } from '../../src/auth/operations/repositories/authentication-operation.repository';
import { AuthenticationChallengeCleanupRepository } from '../../src/auth/challenge/repositories/authentication-challenge-cleanup.repository';
import { AuthenticationDeliveryCleanupRepository } from '../../src/auth/delivery/repositories/authentication-delivery-cleanup.repository';
import type { AuthenticationOperationRequest } from '../../src/auth/operations/types/authentication-operation.type';
import { validateEnvironment } from '../../src/config/environment.validation';
import { MailSubmissionGateService } from '../../src/mail/services/mail-submission-gate.service';
import { ResendMailHttpClient } from '../../src/mail/services/resend-mail-http-client.service';
import { MailService } from '../../src/mail/mail.service';
import { MailDeliveryRepository } from '../../src/mail/repositories/mail-delivery.repository';
import { MailDeliveryWorkerService } from '../../src/mail/services/mail-delivery-worker.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { observeMailDeferrals } from './observe-mail-deferrals';
import type {
  ReplicaCommand,
  ReplicaExecution,
  ReplicaStopped,
} from './concurrency-protocol';

let testingModule: TestingModule | undefined;
let started = false;
let notificationsStarted = false;
const observed: ReplicaStopped = { grants: [], deferredCount: 0 };
let prepared: { id: string; request: AuthenticationOperationRequest }[] = [];

function reply(id: number, ok: boolean, data?: unknown): Promise<void> {
  return new Promise((resolve) => {
    process.send?.({ id, ok, data }, () => resolve());
  });
}

async function close() {
  if (started) {
    await testingModule
      ?.get(AuthenticationDeliveryWorkerService)
      .onModuleDestroy();
    started = false;
  }
  if (notificationsStarted) {
    await testingModule?.get(MailDeliveryWorkerService).onModuleDestroy();
    notificationsStarted = false;
  }
  await testingModule?.close();
  testingModule = undefined;
}

async function initialize() {
  const databaseLifecycle = loadDatabaseRuntime();
  const endpoint = new URL(process.env.LOAD_PROVIDER_ENDPOINT ?? '');
  if (
    !process.send ||
    process.env.DOTENV_CONFIG_PATH !== '/dev/null' ||
    endpoint.protocol !== 'http:' ||
    endpoint.hostname !== '127.0.0.1' ||
    !/^\/emails\/[01]$/.test(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid isolated concurrency replica configuration.');
  class LocalClient extends ResendMailHttpClient {
    protected readonly endpoint = endpoint.toString();
  }
  testingModule = await Test.createTestingModule({
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
  const gate = testingModule.get(MailSubmissionGateService);
  if (process.env.LOAD_STAND_SCENARIO === 'mixed-mail') {
    observed.deferrals = observeMailDeferrals(
      testingModule.get(PrismaService),
      testingModule.get(AuthenticationDeliveryRepository),
      testingModule.get(MailDeliveryRepository),
    );
  }
  const acquire = gate.tryAcquire.bind(gate) as typeof gate.tryAcquire;
  // Observe committed results only. The real gate/transaction is always called;
  // no policy, clock, database state, outcome or failure is substituted.
  gate.tryAcquire = async () => {
    const result = await acquire();
    if (result.outcome === 'GRANTED')
      observed.grants.push({
        now: result.operationNowMicros,
        next: result.nextPermissionNotBeforeMicros,
      });
    if (result.outcome === 'DEFERRED') observed.deferredCount++;
    return result;
  };
  const config = testingModule.get(ConfigService);
  const settings = Object.fromEntries(
    [
      'AUTH_DELIVERY_GLOBAL_BURST',
      'AUTH_DELIVERY_GLOBAL_RATE',
      'AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS',
      'AUTH_DELIVERY_BACKLOG_LIMIT',
      'AUTH_DELIVERY_IP_BURST',
      'AUTH_DELIVERY_IP_RATE',
      'AUTH_DELIVERY_IP_PERIOD_SECONDS',
      'MAIL_RESEND_SUBMISSIONS_PER_SECOND',
      'MAIL_RESEND_TEAM_REQUESTS_PER_SECOND',
      'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
      'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
      'AUTH_DELIVERY_WORKER_CONCURRENCY',
      'AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE',
      'MAIL_DELIVERY_WORKER_INTERVAL_SECONDS',
      'MAIL_DELIVERY_WORKER_BATCH_SIZE',
    ].map((key) => [key, config.getOrThrow<number>(key)]),
  );
  const [identity] = await testingModule.get(PrismaService).$queryRaw<
    { oid: string }[]
  >`SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()`;
  await reply(0, true, {
    pid: process.pid,
    settings,
    databaseLifecycle,
    databaseOid: identity.oid,
  });
}

async function handle(command: ReplicaCommand) {
  if (!testingModule) throw new Error('Replica not ready.');
  const operations = testingModule.get(AuthenticationOperationService);
  switch (command.kind) {
    case 'PREPARE': {
      if (
        prepared.length ||
        command.requests.length < 1 ||
        command.requests.length > 8
      )
        throw new Error('Invalid bounded admission batch.');
      prepared = await Promise.all(
        command.requests.map(async (request) => ({
          id: await operations.createOperationId(),
          request,
        })),
      );
      return prepared.map(({ id }) => id);
    }
    case 'EXECUTE': {
      if (!prepared.length) throw new Error('No prepared admissions.');
      const batch = prepared;
      prepared = [];
      return Promise.all(
        batch.map(async ({ id, request }): Promise<ReplicaExecution> => {
          const start = performance.now();
          try {
            return {
              operationId: id,
              response: await operations.execute(id, request),
              elapsedMs: performance.now() - start,
            };
          } catch (error) {
            return {
              operationId: id,
              error:
                error instanceof AuthenticationOperationError
                  ? error.reason
                  : 'UNEXPECTED',
              elapsedMs: performance.now() - start,
            };
          }
        }),
      );
    }
    case 'START_WORKER': {
      if (started) throw new Error('Worker already started.');
      started = true;
      const worker = testingModule.get(AuthenticationDeliveryWorkerService);
      worker.onModuleInit();
      return { summary: await worker.runOnce() };
    }
    case 'EXECUTE_OPERATION': {
      if (
        process.env.LOAD_STAND_SCENARIO !== 'rollback-cleanup' ||
        loadDatabaseRuntime().stateMode !== 'isolated'
      )
        throw new Error('Invalid rollback scenario command.');
      const start = performance.now();
      try {
        return {
          operationId: command.operationId,
          response: await operations.execute(
            command.operationId,
            command.request,
          ),
          elapsedMs: performance.now() - start,
        } satisfies ReplicaExecution;
      } catch (error) {
        return {
          operationId: command.operationId,
          error:
            error instanceof AuthenticationOperationError
              ? error.reason
              : 'UNEXPECTED',
          elapsedMs: performance.now() - start,
        } satisfies ReplicaExecution;
      }
    }
    case 'CLEANUP': {
      if (
        process.env.LOAD_STAND_SCENARIO !== 'rollback-cleanup' ||
        loadDatabaseRuntime().stateMode !== 'isolated' ||
        started ||
        notificationsStarted
      )
        throw new Error('Invalid cleanup scenario command.');
      const challenge = testingModule.get(
        AuthenticationChallengeCleanupRepository,
      );
      return {
        clearedProof: await challenge.clearOneExpiredEnvelopeBatch(100),
        deletedDelivery: await testingModule
          .get(AuthenticationDeliveryCleanupRepository)
          .deleteOneRetainedTerminalBatch(100),
        deletedChallenge: await challenge.deleteOneRetainedChallengeBatch(100),
        deletedSubject: await challenge.deleteOneOrphanedSubjectBatch(100),
        deletedReceipt: await testingModule
          .get(AuthenticationOperationRepository)
          .deleteRetainedBatch(100),
      };
    }
    case 'ENQUEUE_NOTIFICATIONS': {
      if (
        process.env.LOAD_STAND_SCENARIO !== 'mixed-mail' ||
        command.notifications.length < 1 ||
        command.notifications.length > 4
      )
        throw new Error('Invalid bounded notification batch.');
      return Promise.all(
        command.notifications.map((notification) =>
          testingModule!.get(MailService).sendNewSessionEmail(notification),
        ),
      );
    }
    case 'START_MIXED_WORKERS': {
      if (
        process.env.LOAD_STAND_SCENARIO !== 'mixed-mail' ||
        started ||
        notificationsStarted
      )
        throw new Error('Invalid mixed worker startup.');
      started = true;
      notificationsStarted = true;
      const auth = testingModule.get(AuthenticationDeliveryWorkerService),
        mail = testingModule.get(MailDeliveryWorkerService);
      auth.onModuleInit();
      mail.onModuleInit();
      const [summary, notifications] = await Promise.all([
        auth.runOnce(),
        mail.runOnce(),
      ]);
      return { summary, notifications };
    }
    case 'STOP':
      await close();
      return observed;
  }
}

// Parent owns the bounded protocol and does not send concurrent commands to one
// replica. Each EXECUTE internally races the prepared operations on real PG.
process.on('message', (message: { id: number; command: ReplicaCommand }) => {
  void handle(message.command).then(
    async (data) => {
      await reply(message.id, true, data);
      if (message.command.kind === 'STOP') process.disconnect();
    },
    async () => {
      await reply(message.id, false);
    },
  );
});
process.on('disconnect', () => {
  void close();
});
void initialize().catch(async () => {
  await close();
  await reply(0, false);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
