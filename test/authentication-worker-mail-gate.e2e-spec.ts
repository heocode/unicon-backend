import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuthModule } from '../src/auth/auth.module';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import { AuthenticationDeliveryWorkerService } from '../src/auth/delivery/services/authentication-delivery-worker.service';
import type { ClaimedAuthenticationDelivery } from '../src/auth/delivery/types/authentication-delivery.type';
import { validateEnvironment } from '../src/config/environment.validation';
import {
  AuthenticationChallengePurpose,
  AuthenticationIdentityType,
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
} from '../src/generated/prisma/enums';
import { MAIL_SUBMISSION_GATE } from '../src/mail/constants/mail-submission-gate.constants';
import { MailProviderPressureService } from '../src/mail/services/mail-provider-pressure.service';
import { ResendMailHttpClient } from '../src/mail/services/resend-mail-http-client.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';

// Full worker -> orchestration -> adapter -> common transport -> gate -> HTTP.
// Two independent Nest/Prisma instances. No database/provider service mocks.
describe('Auth worker shared mail integration (PostgreSQL + HTTP)', () => {
  jest.setTimeout(20000);
  const prefix = 'e2e:worker-mail-gate:';
  let first: TestingModule, second: TestingModule, prisma: PrismaService;
  let repository: AuthenticationDeliveryRepository,
    orchestration: AuthenticationDeliveryOrchestrationService;
  let worker: AuthenticationDeliveryWorkerService,
    secondWorker: AuthenticationDeliveryWorkerService;
  let server: Server, endpoint: string;
  let status = 200,
    errorName = '',
    responseHeaders: Record<string, string> = {};
  let disconnect = false,
    breakPressure = false;
  let calls: { key: string; payloadHash: string }[] = [];
  class LocalResendHttpClient extends ResendMailHttpClient {
    protected readonly endpoint = endpoint;
  }
  async function createModule() {
    return Test.createTestingModule({
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
      .useClass(LocalResendHttpClient)
      .compile();
  }
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          calls.push({
            key: request.headers['idempotency-key'] as string,
            payloadHash: createHash('sha256')
              .update(Buffer.concat(chunks))
              .digest('hex'),
          });
          if (breakPressure)
            await prisma.mailProviderPressure.delete({ where: { id: 1 } });
          if (disconnect) {
            response.destroy();
            return;
          }
          response.writeHead(status, {
            'content-type': 'application/json',
            ...responseHeaders,
          });
          response.end(
            JSON.stringify(
              status < 300 ? { id: 'local-auth-message' } : { name: errorName },
            ),
          );
        })().catch(() => response.destroy());
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
    first = await createModule();
    second = await createModule();
    prisma = first.get(PrismaService);
    repository = first.get(AuthenticationDeliveryRepository);
    orchestration = first.get(AuthenticationDeliveryOrchestrationService);
    worker = first.get(AuthenticationDeliveryWorkerService);
    secondWorker = second.get(AuthenticationDeliveryWorkerService);
  });
  async function databaseNow(): Promise<number> {
    const [time] = await prisma.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return time.now.getTime();
  }
  async function reset() {
    await prisma.authenticationChallengeSubject.deleteMany({
      where: { key: { startsWith: prefix } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: MAIL_SUBMISSION_GATE.key },
    });
    await prisma.mailProviderPressure.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {
        retryNotBeforeMicros: 0n,
        dailyNotBeforeMicros: 0n,
        monthlyBlocked: false,
        revision: 0n,
      },
    });
  }
  beforeEach(async () => {
    await reset();
    calls = [];
    status = 200;
    errorName = '';
    responseHeaders = {};
    disconnect = false;
    breakPressure = false;
  });
  afterEach(reset);
  afterAll(async () => {
    await first?.close();
    await second?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  async function createDelivery() {
    const id = randomUUID(),
      recipient = `student-${id}@example.edu`;
    const proof = first
      .get(AuthenticationChallengeProofFactoryService)
      .generate({
        challengeId: id,
        purpose: AuthenticationChallengePurpose.SIGN_IN,
        normalizedIdentity: recipient,
      });
    await prisma.authenticationChallenge.create({
      data: {
        id,
        subject: { create: { key: `${prefix}${id}` } },
        identityType: AuthenticationIdentityType.INSTITUTIONAL_EMAIL,
        normalizedIdentity: recipient,
        purpose: AuthenticationChallengePurpose.SIGN_IN,
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
        expiresAt: new Date((await databaseNow()) + 600000),
        retentionExpiresAt: new Date((await databaseNow()) + 86400000),
      },
    });
    return prisma.authenticationChallengeDelivery.create({
      data: {
        challengeId: id,
        method: AuthenticationDeliveryMethod.EMAIL,
        origin: AuthenticationDeliveryOrigin.INITIAL,
        recipientSnapshot: recipient,
        idempotencyKey: randomUUID(),
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date((await databaseNow()) + 86400000),
      },
    });
  }
  function row(id: string) {
    return prisma.authenticationChallengeDelivery.findUniqueOrThrow({
      where: { id },
    });
  }
  async function pressureState() {
    return prisma.mailProviderPressure.findUniqueOrThrow({ where: { id: 1 } });
  }
  async function due(id: string) {
    await prisma.authenticationChallengeDelivery.update({
      where: { id },
      data: { nextAttemptAt: new Date((await databaseNow()) - 1000) },
    });
  }
  async function waitForPermission() {
    const state = await prisma.gcraRateLimit.findUnique({
      where: { key: MAIL_SUBMISSION_GATE.key },
    });
    if (state)
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${state.idleAfterMicros.toString()}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
  }
  async function processNext() {
    const claim = await repository.claimNextDelivery();
    if (!claim) throw new Error('Expected claim.');
    return orchestration.process(claim);
  }

  it('leases without charging; starts one attempt after grant and marks the real HTTP result sent', async () => {
    const delivery = await createDelivery(),
      claim = (await repository.claimNextDelivery())!;
    expect(claim.attemptCount).toBe(0);
    expect(await row(delivery.id)).toMatchObject({
      status: 'PROCESSING',
      attemptCount: 0,
      attemptedAt: null,
      processingAttemptStarted: false,
    });
    expect(await orchestration.process(claim)).toEqual({ outcome: 'SENT' });
    expect(await row(delivery.id)).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      processingAttemptStarted: false,
      processingLeaseId: null,
      providerMessageId: 'local-auth-message',
    });
    expect(calls).toHaveLength(1);
  });

  it('capacity waiting leaves count, attemptedAt, failure, proof and idempotency unchanged', async () => {
    const delivery = await createDelivery();
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: delivery.challengeId },
    });
    const boundary = BigInt((await databaseNow()) + 30000) * 1000n + 999n;
    await prisma.mailProviderPressure.update({
      where: { id: 1 },
      data: { retryNotBeforeMicros: boundary },
    });
    const result = await worker.runOnce();
    expect(result.deferredCount).toBe(1);
    expect(result.sentCount).toBe(0);
    expect(await row(delivery.id)).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      attemptedAt: null,
      lastSafeFailureCode: null,
      processingLeaseId: null,
      idempotencyKey: delivery.idempotencyKey,
      nextAttemptAt: new Date(Number((boundary + 999n) / 1000n)),
    });
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: delivery.challengeId },
      }),
    ).toEqual(challenge);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('monthly waiting survives more than five cycles and resumes only after explicit recovery', async () => {
    const delivery = await createDelivery();
    const pressureService = first.get(MailProviderPressureService);
    await pressureService.observe({
      statusCode: 429,
      errorName: 'monthly_quota_exceeded',
      headers: {},
    });
    for (let i = 0; i < 7; i++) {
      if (i) await due(delivery.id);
      expect((await worker.runOnce()).deferredCount).toBe(1);
      expect(await row(delivery.id)).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        attemptedAt: null,
        lastSafeFailureCode: null,
      });
    }
    expect(calls).toHaveLength(0);
    expect(
      await second
        .get(MailProviderPressureService)
        .clearMonthlyBlock((await pressureState()).revision),
    ).toBe(true);
    await due(delivery.id);
    expect((await secondWorker.runOnce()).sentCount).toBe(1);
    expect(await row(delivery.id)).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      idempotencyKey: delivery.idempotencyKey,
    });
  });

  it('cancels closed challenges despite a future capacity schedule', async () => {
    const delivery = await createDelivery();
    await prisma.mailProviderPressure.update({
      where: { id: 1 },
      data: { retryNotBeforeMicros: 9223372036854775807n },
    });
    expect((await worker.runOnce()).deferredCount).toBe(1);
    const pending = await row(delivery.id);
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: delivery.challengeId },
    });
    expect(pending.nextAttemptAt!.getTime()).toBe(
      challenge.expiresAt.getTime() - 120000 + 1,
    );
    await prisma.authenticationChallenge.update({
      where: { id: delivery.challengeId },
      data: {
        consumedAt: new Date(),
        encryptedProof: null,
        proofEncryptionIv: null,
        proofEncryptionTag: null,
      },
    });
    expect((await worker.runOnce()).cancelledCount).toBe(1);
    expect(await row(delivery.id)).toMatchObject({
      status: 'CANCELLED',
      attemptCount: 0,
      processingLeaseId: null,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])(
    'recovers an expired lease without losing charged processing history (started=%s)',
    async (started) => {
      const delivery = await createDelivery(),
        abandoned = (await repository.claimNextDelivery())!;
      if (started)
        expect(
          await repository.startProcessingAttempt(abandoned),
        ).toMatchObject({ outcome: 'STARTED', attemptCount: 1 });
      await prisma.authenticationChallengeDelivery.update({
        where: { id: delivery.id },
        data: {
          processingLeaseExpiresAt: new Date((await databaseNow()) - 1000),
        },
      });
      const reclaimed = (await second
        .get(AuthenticationDeliveryRepository)
        .claimNextDelivery())!;
      expect(reclaimed.attemptCount).toBe(started ? 1 : 0);
      expect(await orchestration.process(abandoned)).toEqual({
        outcome: 'LEASE_LOST',
      });
      expect(
        await second
          .get(AuthenticationDeliveryOrchestrationService)
          .process(reclaimed),
      ).toEqual({ outcome: 'SENT' });
      expect(await row(delivery.id)).toMatchObject({
        status: 'SENT',
        attemptCount: started ? 2 : 1,
      });
      expect(calls).toHaveLength(1);
    },
  );

  it('two real workers share capacity and retain unstarted attempts for deferred work', async () => {
    const deliveries = await Promise.all(
      Array.from({ length: 8 }, createDelivery),
    );
    const summaries = await Promise.all([
      worker.runOnce(),
      secondWorker.runOnce(),
    ]);
    const rows = await prisma.authenticationChallengeDelivery.findMany({
      where: { id: { in: deliveries.map((item) => item.id) } },
    });
    const sent = rows.filter((item) => item.status === 'SENT');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(sent.length);
    expect(
      summaries.reduce((sum, item) => sum + item.deferredCount, 0),
    ).toBeGreaterThanOrEqual(1);
    for (const item of rows)
      expect(item.attemptCount).toBe(item.status === 'SENT' ? 1 : 0);
    expect(new Set(calls.map((call) => call.key)).size).toBe(calls.length);
  });

  it('provider 429 pauses other Deliveries; retries retain their original payload and key', async () => {
    const delivery = await createDelivery();
    status = 429;
    errorName = 'rate_limit_exceeded';
    responseHeaders = { 'retry-after': '30' };
    expect(await processNext()).toEqual({ outcome: 'RETRY_SCHEDULED' });
    expect(await row(delivery.id)).toMatchObject({
      attemptCount: 1,
      lastSafeFailureCode: 'RESEND_RATE_LIMITED',
    });
    const other = await createDelivery();
    expect((await secondWorker.runOnce()).deferredCount).toBeGreaterThanOrEqual(
      1,
    );
    expect(await row(other.id)).toMatchObject({
      attemptCount: 0,
      attemptedAt: null,
    });
    expect(calls).toHaveLength(1);
    // Controlled provider recovery fixture; does not change domain admission/proof.
    await prisma.mailProviderPressure.update({
      where: { id: 1 },
      data: { retryNotBeforeMicros: 0n },
    });
    status = 200;
    responseHeaders = {};
    await due(delivery.id);
    await waitForPermission();
    const retry = (await repository.claimNextDelivery())!;
    expect(retry.id).toBe(delivery.id);
    expect(await orchestration.process(retry)).toEqual({ outcome: 'SENT' });
    expect(calls[1]).toEqual(calls[0]);
    expect((await row(delivery.id)).attemptCount).toBe(2);
  });

  it('keeps ambiguous retries under the five-attempt limit with the same provider key and content', async () => {
    const delivery = await createDelivery();
    disconnect = true;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        await due(delivery.id);
        await waitForPermission();
      }
      expect(await processNext()).toEqual({
        outcome: attempt === 5 ? 'FAILED' : 'RETRY_SCHEDULED',
      });
      expect((await row(delivery.id)).attemptCount).toBe(attempt);
    }
    expect(calls).toHaveLength(5);
    expect(
      calls.every(
        (call) =>
          call.key === calls[0].key &&
          call.payloadHash === calls[0].payloadHash,
      ),
    ).toBe(true);
    expect(await repository.claimNextDelivery()).toBeNull();
  });

  it('gate infrastructure failure defers without spending a processing attempt or sending HTTP', async () => {
    const delivery = await createDelivery();
    await prisma.mailProviderPressure.delete({ where: { id: 1 } });
    expect((await worker.runOnce()).deferredCount).toBe(1);
    expect(await row(delivery.id)).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      attemptedAt: null,
      lastSafeFailureCode: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('preserves accepted delivery if shared pressure recording fails after HTTP', async () => {
    const delivery = await createDelivery();
    breakPressure = true;
    responseHeaders = { 'retry-after': '30' };
    expect(await processNext()).toEqual({ outcome: 'SENT' });
    expect(await row(delivery.id)).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it.each(['consumed', 'window', 'lease'])(
    'rechecks %s after a real gate lock wait before sending',
    async (change) => {
      const delivery = await createDelivery(),
        claim = (await repository.claimNextDelivery())!;
      let locked!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const unlock = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holding = prisma.$transaction(
        async (tx) => {
          await first
            .get(GcraAdmissionRepository)
            .lockAliases(tx, [MAIL_SUBMISSION_GATE.key]);
          locked();
          await unlock;
        },
        { timeout: 10000 },
      );
      let pending: ReturnType<typeof orchestration.process> | undefined;
      try {
        await ready;
        pending = orchestration.process(claim);
        void pending.catch(() => undefined);
        let waited = false;
        for (let i = 0; i < 100; i++) {
          const rows = await prisma.$queryRaw<
            { pid: number }[]
          >`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'`;
          if (rows.length) {
            waited = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waited).toBe(true);
        if (change === 'lease')
          await prisma.authenticationChallengeDelivery.update({
            where: { id: delivery.id },
            data: {
              processingLeaseExpiresAt: new Date((await databaseNow()) - 1000),
            },
          });
        else
          await prisma.authenticationChallenge.update({
            where: { id: delivery.challengeId },
            data:
              change === 'consumed'
                ? {
                    consumedAt: new Date(),
                    encryptedProof: null,
                    proofEncryptionIv: null,
                    proofEncryptionTag: null,
                  }
                : { expiresAt: new Date((await databaseNow()) + 119000) },
          });
        release();
        await holding;
        expect(await pending).toEqual({
          outcome: change === 'lease' ? 'LEASE_LOST' : 'CANCELLED',
        });
        expect((await row(delivery.id)).attemptCount).toBe(0);
        expect(calls).toHaveLength(0);
      } finally {
        release();
        await Promise.allSettled(pending ? [holding, pending] : [holding]);
      }
    },
  );

  it('rolls back a failed attempt-start without sending or refunding the committed mail permission', async () => {
    const delivery = await createDelivery(),
      claim: ClaimedAuthenticationDelivery =
        (await repository.claimNextDelivery())!;
    await prisma.$executeRaw`CREATE FUNCTION auth_worker_start_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."processingAttemptStarted" AND NOT OLD."processingAttemptStarted" THEN RAISE EXCEPTION 'Private SQL fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`;
    await prisma.$executeRaw`CREATE TRIGGER auth_worker_start_fault BEFORE UPDATE ON "AuthenticationChallengeDelivery" FOR EACH ROW EXECUTE FUNCTION auth_worker_start_fault()`;
    try {
      expect((await orchestration.process(claim)).outcome).toBe('DEFERRED');
      expect(await row(delivery.id)).toMatchObject({
        attemptCount: 0,
        attemptedAt: null,
      });
      expect(calls).toHaveLength(0);
      expect(
        await prisma.gcraRateLimit.findUnique({
          where: { key: MAIL_SUBMISSION_GATE.key },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.$executeRaw`DROP TRIGGER auth_worker_start_fault ON "AuthenticationChallengeDelivery"`;
      await prisma.$executeRaw`DROP FUNCTION auth_worker_start_fault()`;
    }
  });
  it('migration preserves existing counters and marks only charged processing rows', async () => {
    const schema = `worker_attempt_migration_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(
      resolve(
        __dirname,
        '../prisma/migrations/20261112040000_separate_auth_delivery_lease_attempt/migration.sql',
      ),
      'utf8',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRaw`SELECT set_config('search_path', ${schema}, true)`;
      await tx.$executeRaw`CREATE TABLE "AuthenticationChallengeDelivery" ("id" text PRIMARY KEY, "status" text NOT NULL, "attemptCount" integer NOT NULL)`;
      await tx.$executeRaw`INSERT INTO "AuthenticationChallengeDelivery" VALUES ('pending','PENDING',0),('charged','PROCESSING',4),('unstarted','PROCESSING',0),('failed','FAILED',5)`;
      for (const sql of migration
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await tx.$executeRawUnsafe(sql);
      const rows = await tx.$queryRaw<
        {
          id: string;
          status: string;
          attemptCount: number;
          processingAttemptStarted: boolean;
        }[]
      >`SELECT * FROM "AuthenticationChallengeDelivery" ORDER BY "id"`;
      expect(rows).toEqual([
        {
          id: 'charged',
          status: 'PROCESSING',
          attemptCount: 4,
          processingAttemptStarted: true,
        },
        {
          id: 'failed',
          status: 'FAILED',
          attemptCount: 5,
          processingAttemptStarted: false,
        },
        {
          id: 'pending',
          status: 'PENDING',
          attemptCount: 0,
          processingAttemptStarted: false,
        },
        {
          id: 'unstarted',
          status: 'PROCESSING',
          attemptCount: 0,
          processingAttemptStarted: false,
        },
      ]);
      await tx.$executeRaw`SAVEPOINT invalid_started_flag`;
      await expect(
        tx.$executeRaw`UPDATE "AuthenticationChallengeDelivery" SET "processingAttemptStarted"=true WHERE "id"='pending'`,
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT invalid_started_flag`;
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });
});
