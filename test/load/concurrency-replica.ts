import '../setup-env';
import './setup';

import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { performance } from 'node:perf_hooks';

import { AuthModule } from '../../src/auth/auth.module';
import { AuthenticationDeliveryWorkerService } from '../../src/auth/delivery/services/authentication-delivery-worker.service';
import { AuthenticationOperationError } from '../../src/auth/operations/errors/authentication-operation.error';
import { AuthenticationOperationService } from '../../src/auth/operations/services/authentication-operation.service';
import type { AuthenticationOperationRequest } from '../../src/auth/operations/types/authentication-operation.type';
import { validateEnvironment } from '../../src/config/environment.validation';
import { MailSubmissionGateService } from '../../src/mail/services/mail-submission-gate.service';
import { ResendMailHttpClient } from '../../src/mail/services/resend-mail-http-client.service';
import type {
  ReplicaCommand,
  ReplicaExecution,
  ReplicaStopped,
} from './concurrency-protocol';

let testingModule: TestingModule | undefined;
let started = false;
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
  await testingModule?.close();
  testingModule = undefined;
}

async function initialize() {
  const database = new URL(process.env.DATABASE_URL ?? '');
  const endpoint = new URL(process.env.LOAD_PROVIDER_ENDPOINT ?? '');
  if (
    !process.send ||
    process.env.DOTENV_CONFIG_PATH !== '/dev/null' ||
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1'].includes(database.hostname) ||
    database.port !== '5433' ||
    database.pathname !== '/unicon_load_test' ||
    database.username !== 'unicon_e2e' ||
    database.search ||
    database.hash ||
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
      'MAIL_RESEND_SUBMISSIONS_PER_SECOND',
      'MAIL_RESEND_TEAM_REQUESTS_PER_SECOND',
      'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
      'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
      'AUTH_DELIVERY_WORKER_CONCURRENCY',
      'AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE',
    ].map((key) => [key, config.getOrThrow<number>(key)]),
  );
  await reply(0, true, { pid: process.pid, settings });
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
