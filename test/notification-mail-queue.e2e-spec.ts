import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AuthModule } from '../src/auth/auth.module';
import { AccountModule } from '../src/account/account.module';
import { AccountDeletionFinalizationService } from '../src/account/services/account-deletion-finalization.service';
import { AccountDeletionNotificationService } from '../src/notifications/services/account-deletion-notification.service';
import { MailDeliveryEncryptionService } from '../src/mail/services/mail-delivery-encryption.service';
import { AuthenticationChallengeProofFactoryService } from '../src/auth/challenge/services/authentication-challenge-proof-factory.service';
import { AuthenticationOperationService } from '../src/auth/operations/services/authentication-operation.service';
import { AuthenticationDeliveryCleanupRepository } from '../src/auth/delivery/repositories/authentication-delivery-cleanup.repository';
import { NotificationDeliveryService } from '../src/notifications/services/notification-delivery.service';
import { AuthenticationDeliveryRepository } from '../src/auth/delivery/repositories/authentication-delivery.repository';
import { AuthenticationDeliveryOrchestrationService } from '../src/auth/delivery/services/authentication-delivery-orchestration.service';
import { validateEnvironment } from '../src/config/environment.validation';
import { MailService } from '../src/mail/mail.service';
import { MailDeliveryRepository } from '../src/mail/repositories/mail-delivery.repository';
import { MailDeliveryWorkerService } from '../src/mail/services/mail-delivery-worker.service';
import { MailProviderPressureService } from '../src/mail/services/mail-provider-pressure.service';
import { ResendMailHttpClient } from '../src/mail/services/resend-mail-http-client.service';
import { MAIL_SUBMISSION_GATE } from '../src/mail/constants/mail-submission-gate.constants';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';

// Real DB, encryption, renderers, leases, workers and common transport. The sole
// replacement is the destination URL of the HTTP client (local fake provider).
describe('Durable notification mail (PostgreSQL + HTTP)', () => {
  jest.setTimeout(20000);
  let first: TestingModule, second: TestingModule, prisma: PrismaService;
  let mail: MailService,
    repository: MailDeliveryRepository,
    worker: MailDeliveryWorkerService;
  let server: Server,
    endpoint: string,
    universityId: string,
    userId: string,
    email: string;
  let status = 200,
    errorName = '',
    headers: Record<string, string> = {},
    disconnect = false,
    breakPressure = false;
  let calls: { key: string; hash: string; recipient: string }[] = [];
  let holdResponse: Promise<void> | undefined;
  const prefix = 'e2e:notification-mail:';
  const operationIds = new Set<string>(),
    admissionKeys = new Set<string>(),
    cooldownKeys = new Set<string>();
  class LocalClient extends ResendMailHttpClient {
    protected readonly endpoint = endpoint;
  }
  async function instance() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnvironment,
        }),
        AuthModule,
        AccountModule,
      ],
    })
      .overrideProvider(ResendMailHttpClient)
      .useClass(LocalClient)
      .compile();
  }
  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks),
            payload = JSON.parse(body.toString()) as { to: string[] };
          calls.push({
            key: req.headers['idempotency-key'] as string,
            hash: createHash('sha256').update(body).digest('hex'),
            recipient: payload.to[0],
          });
          if (holdResponse) await holdResponse;
          if (breakPressure)
            await prisma.mailProviderPressure.delete({ where: { id: 1 } });
          if (disconnect) {
            res.destroy();
            return;
          }
          res.writeHead(status, {
            'content-type': 'application/json',
            ...headers,
          });
          res.end(
            JSON.stringify(
              status < 300
                ? { id: 'local-notification-id' }
                : { name: errorName },
            ),
          );
        })().catch(() => res.destroy());
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
    first = await instance();
    second = await instance();
    prisma = first.get(PrismaService);
    mail = first.get(MailService);
    repository = first.get(MailDeliveryRepository);
    worker = first.get(MailDeliveryWorkerService);
    universityId = (
      await prisma.university.create({
        data: { name: `${prefix}${randomUUID()}` },
      })
    ).id;
  });
  async function databaseNow(): Promise<number> {
    const [time] = await prisma.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS "now"`;
    return time.now.getTime();
  }
  async function clean() {
    await prisma.authenticationOperation.deleteMany({
      where: { id: { in: [...operationIds] } },
    });
    await prisma.gcraRateLimit.deleteMany({
      where: { key: { in: [...admissionKeys] } },
    });
    await prisma.authenticationRateLimit.deleteMany({
      where: { key: { in: [...cooldownKeys] } },
    });
    operationIds.clear();
    admissionKeys.clear();
    cooldownKeys.clear();
    await prisma.authenticationChallengeSubject.deleteMany({
      where: {
        OR: [
          { key: { startsWith: prefix } },
          { normalizedIdentity: { endsWith: '@mail-queue.example.edu' } },
        ],
      },
    });
    await prisma.notificationDelivery.deleteMany({
      where: { recipient: { endsWith: '@mail-queue.example.edu' } },
    });
    await prisma.user.deleteMany({ where: { universityId } });
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
    await clean();
    status = 200;
    errorName = '';
    headers = {};
    disconnect = false;
    breakPressure = false;
    holdResponse = undefined;
    calls = [];
    email = `${randomUUID()}@mail-queue.example.edu`;
    userId = (
      await prisma.user.create({
        data: {
          email,
          username: `queue_${randomUUID()}`,
          universityId,
          passwordHash: 'unused-test-hash',
          status: 'ACTIVE',
          emailVerified: true,
        },
      })
    ).id;
  });
  afterEach(clean);
  afterAll(async () => {
    await prisma?.university.delete({ where: { id: universityId } });
    await first?.close();
    await second?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  const notification = () => ({
    recipient: email,
    idempotencyKey: `${prefix}${randomUUID()}`,
    occurredAt: new Date('2026-08-17T12:00:00Z'),
    deviceModel: null,
    platform: 'WEB' as const,
    osVersion: null,
    appVersion: null,
    locationCountryCode: null,
    locationCity: null,
    riskLevel: null,
    riskSignals: [],
  });
  async function enqueue() {
    return mail.sendNewSessionEmail(notification(), { userId });
  }
  function row(id: string) {
    return prisma.notificationDelivery.findUniqueOrThrow({ where: { id } });
  }
  async function due(id: string) {
    await prisma.notificationDelivery.update({
      where: { id },
      data: { mailNextAttemptAt: new Date((await databaseNow()) - 1000) },
    });
  }
  async function waitPermission() {
    const state = await prisma.gcraRateLimit.findUnique({
      where: { key: MAIL_SUBMISSION_GATE.key },
    });
    if (state)
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${state.idleAfterMicros.toString()}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
  }
  async function processNext(instance = first) {
    const claim = await instance.get(MailDeliveryRepository).claimNext();
    if (!claim) throw new Error('Expected queued mail.');
    return instance.get(MailDeliveryWorkerService).process(claim);
  }

  async function admittedAuth() {
    const beforeGcra = new Set(
      (await prisma.gcraRateLimit.findMany({ select: { key: true } })).map(
        (item) => item.key,
      ),
    );
    const beforeCooldown = new Set(
      (
        await prisma.authenticationRateLimit.findMany({ select: { key: true } })
      ).map((item) => item.key),
    );
    const operations = first.get(AuthenticationOperationService);
    const operationId = await operations.createOperationId();
    operationIds.add(operationId);
    try {
      const response = await operations.execute(operationId, {
        kind: 'SIGN_IN_REQUEST',
        input: {
          normalizedIdentity: email,
          ipAddress: `2001:db8:${randomUUID().slice(0, 4)}::1`,
          templateProtocolVersion: 1,
        },
      });
      if (response.result.outcome !== 'CREATED')
        throw new Error('Expected admitted auth work.');
      return {
        id: response.result.deliveryId,
        challengeId: response.result.challengeId,
      };
    } finally {
      for (const item of await prisma.gcraRateLimit.findMany({
        select: { key: true },
      }))
        if (!beforeGcra.has(item.key)) admissionKeys.add(item.key);
      for (const item of await prisma.authenticationRateLimit.findMany({
        select: { key: true },
      }))
        if (!beforeCooldown.has(item.key)) cooldownKeys.add(item.key);
    }
  }
  async function admissionSnapshot() {
    return {
      rates: await prisma.gcraRateLimit.findMany({
        where: { key: { in: [...admissionKeys] } },
        orderBy: { key: 'asc' },
      }),
      cooldowns: await prisma.authenticationRateLimit.findMany({
        where: { key: { in: [...cooldownKeys] } },
        orderBy: { key: 'asc' },
      }),
      receipts: await prisma.authenticationOperation.findMany({
        where: { id: { in: [...operationIds] } },
        orderBy: { id: 'asc' },
      }),
    };
  }
  async function authRow(id: string) {
    return prisma.authenticationChallengeDelivery.findUniqueOrThrow({
      where: { id },
    });
  }
  async function runAuth(instance = first) {
    const claim = await instance
      .get(AuthenticationDeliveryRepository)
      .claimNextDelivery();
    return claim
      ? instance.get(AuthenticationDeliveryOrchestrationService).process(claim)
      : null;
  }
  async function drainBoth(authId: string, mailId: string) {
    for (let i = 0; i < 8; i++) {
      await waitPermission();
      await Promise.all([runAuth(second), worker.runOnce()]);
      if (
        (await authRow(authId)).status === 'SENT' &&
        (await row(mailId)).status === 'SENT'
      )
        return;
    }
    throw new Error(
      'Expected both queues to drain after authoritative eligibility.',
    );
  }
  async function waitUntil(milliseconds: number) {
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${String(milliseconds)}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000)/1000)::double precision)`;
  }

  it('durably queues before HTTP and records SENT only after provider acceptance, wiping the envelope', async () => {
    const id = await enqueue(),
      before = await row(id);
    expect(before).toMatchObject({
      status: 'PENDING',
      providerMessageId: null,
      attemptedAt: null,
      mailAttemptCount: 0,
      mailProtocol: 1,
    });
    expect(before.mailPayload).not.toBeNull();
    expect(calls).toHaveLength(0);
    expect(
      before.mailExpiresAt!.getTime() - before.mailQueuedAt!.getTime(),
    ).toBe(82800000);
    expect(await processNext()).toEqual({ outcome: 'SENT' });
    expect(await row(id)).toMatchObject({
      status: 'SENT',
      mailPayload: null,
      mailIv: null,
      mailTag: null,
      mailLeaseId: null,
      mailAttemptCount: 1,
      providerMessageId: 'local-notification-id',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(id);
  });

  it('concurrent enqueue across replicas produces one immutable job and does not replace its snapshot', async () => {
    const input = notification();
    const ids = await Promise.all([
      mail.sendNewSessionEmail(input, { userId }),
      second.get(MailService).sendNewSessionEmail(input, { userId }),
    ]);
    expect(ids[0]).toBe(ids[1]);
    const before = await row(ids[0]);
    expect(
      await mail.sendNewSessionEmail(
        { ...input, deviceModel: 'Changed after enqueue' },
        { userId },
      ),
    ).toBe(ids[0]);
    expect(await row(ids[0])).toEqual(before);
    expect(
      await prisma.notificationDelivery.count({
        where: { idempotencyKey: input.idempotencyKey },
      }),
    ).toBe(1);
  });

  it('two independent workers cannot submit the same leased job twice', async () => {
    const id = await enqueue();
    await Promise.all([
      worker.runOnce(),
      second.get(MailDeliveryWorkerService).runOnce(),
    ]);
    expect((await row(id)).status).toBe('SENT');
    expect(calls).toHaveLength(1);
  });

  it('timed capacity persists exact ceiling milliseconds without charging, changing failure, or losing payload', async () => {
    const id = await enqueue(),
      before = await row(id),
      boundary = BigInt((await databaseNow()) + 30000) * 1000n + 999n;
    await prisma.mailProviderPressure.update({
      where: { id: 1 },
      data: { retryNotBeforeMicros: boundary },
    });
    expect((await worker.runOnce())[0]).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: boundary,
    });
    expect(await row(id)).toMatchObject({
      status: 'PENDING',
      mailAttemptCount: 0,
      attemptedAt: null,
      failureCode: null,
      mailPayload: before.mailPayload,
      mailLeaseId: null,
      mailNextAttemptAt: new Date(Number((boundary + 999n) / 1000n)),
    });
    expect(calls).toHaveLength(0);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).toBeNull();
  });

  it('monthly pause survives seven worker cycles and resumes the same job after verified recovery', async () => {
    const id = await enqueue();
    const pressureService = first.get(MailProviderPressureService);
    await pressureService.observe({
      statusCode: 429,
      errorName: 'monthly_quota_exceeded',
      headers: {},
    });
    for (let i = 0; i < 7; i++) {
      if (i) await due(id);
      expect((await worker.runOnce())[0].outcome).toBe('DEFERRED');
    }
    expect(await row(id)).toMatchObject({
      mailAttemptCount: 0,
      attemptedAt: null,
      status: 'PENDING',
    });
    expect(calls).toHaveLength(0);
    const state = await prisma.mailProviderPressure.findUniqueOrThrow({
      where: { id: 1 },
    });
    await second
      .get(MailProviderPressureService)
      .clearMonthlyBlock(state.revision);
    await due(id);
    expect(await processNext(second)).toEqual({ outcome: 'SENT' });
    expect(calls[0].key).toBe(id);
  });

  it.each([false, true])(
    'recovers persisted leases with correct attempt history (started=%s)',
    async (started) => {
      const id = await enqueue(),
        claim = (await repository.claimNext())!;
      if (started) {
        const encryption = first.get(MailDeliveryEncryptionService);
        expect(
          await repository.startAttempt(claim, encryption.decrypt(claim)),
        ).toBe('STARTED');
      }
      await prisma.notificationDelivery.update({
        where: { id },
        data: { mailLeaseExpiresAt: new Date((await databaseNow()) - 1000) },
      });
      const recovered = (await second.get(MailDeliveryRepository).claimNext())!;
      expect(recovered.mailAttemptCount).toBe(started ? 1 : 0);
      expect(await worker.process(claim)).toEqual({ outcome: 'LEASE_LOST' });
      expect(
        await second.get(MailDeliveryWorkerService).process(recovered),
      ).toEqual({ outcome: 'SENT' });
      expect((await row(id)).mailAttemptCount).toBe(started ? 2 : 1);
      expect(calls).toHaveLength(1);
    },
  );

  it('keeps five ambiguous retries bounded with byte-stable payload and the same provider key', async () => {
    const id = await enqueue();
    disconnect = true;
    for (let i = 1; i <= 5; i++) {
      if (i > 1) {
        await due(id);
        await waitPermission();
      }
      expect(await processNext()).toEqual({
        outcome: i === 5 ? 'FAILED' : 'RETRY_SCHEDULED',
      });
      expect((await row(id)).mailAttemptCount).toBe(i);
    }
    expect(calls).toHaveLength(5);
    expect(
      calls.every((call) => call.key === id && call.hash === calls[0].hash),
    ).toBe(true);
    expect(await repository.claimNext()).toBeNull();
    expect((await row(id)).mailPayload).toBeNull();
  });

  it('preserves known provider Retry-After and cannot bypass it with another notification', async () => {
    const id = await enqueue();
    status = 429;
    errorName = 'rate_limit_exceeded';
    headers = { 'retry-after': '30' };
    expect(await processNext()).toEqual({ outcome: 'RETRY_SCHEDULED' });
    const pressure = await prisma.mailProviderPressure.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect((await row(id)).mailNextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      Number(pressure.retryNotBeforeMicros / 1000n),
    );
    const other = await enqueue();
    expect(
      (await second.get(MailDeliveryWorkerService).runOnce())[0].outcome,
    ).toBe('DEFERRED');
    expect((await row(other)).mailAttemptCount).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('stores no plaintext reset token and never submits a used/inactivated proof', async () => {
    const token = 'test-transient-reset-proof',
      hash = createHash('sha256').update(token).digest('hex');
    const record = await prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: hash,
        expiresAt: new Date((await databaseNow()) + 600000),
      },
    });
    const id = await mail.sendPasswordResetRequestEmail(
      {
        recipient: email,
        idempotencyKey: `PASSWORD_RESET_REQUEST:${record.id}`,
        token,
        tokenId: record.id,
        userId,
        expiresInSeconds: 600,
      },
      { userId },
    );
    const pending = await row(id);
    expect(Buffer.from(pending.mailPayload!).includes(Buffer.from(token))).toBe(
      false,
    );
    expect(pending.mailExpiresAt).toEqual(record.expiresAt);
    expect(JSON.stringify(pending)).not.toContain(token);
    await prisma.passwordResetToken.update({
      where: { id: record.id },
      data: { invalidatedAt: new Date() },
    });
    expect(await processNext()).toEqual({ outcome: 'FAILED' });
    expect(calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({
      failureCode: 'MAIL_PROOF_UNAVAILABLE',
      mailAttemptCount: 0,
      mailPayload: null,
    });
  });

  it('legacy verification rechecks the current user proof before HTTP', async () => {
    const token = 'test-verification-proof';
    await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'PENDING',
        emailVerified: false,
        hashedVerificationToken: createHash('sha256')
          .update(token)
          .digest('hex'),
        verificationTokenExpires: new Date((await databaseNow()) + 600000),
      },
    });
    const id = await mail.sendVerificationEmail(email, token, userId);
    await prisma.user.update({
      where: { id: userId },
      data: { hashedVerificationToken: 'changed-proof-hash' },
    });
    expect(await processNext()).toEqual({ outcome: 'FAILED' });
    expect((await row(id)).failureCode).toBe('MAIL_PROOF_UNAVAILABLE');
    expect(calls).toHaveLength(0);
  });

  it('unknown retained key version defers without dropping encrypted work or spending attempts', async () => {
    const id = await enqueue(),
      before = await row(id);
    await prisma.notificationDelivery.update({
      where: { id },
      data: { mailKeyVersion: 99 },
    });
    expect((await worker.runOnce())[0].outcome).toBe('DEFERRED');
    expect(await row(id)).toMatchObject({
      status: 'PENDING',
      mailPayload: before.mailPayload,
      mailAttemptCount: 0,
    });
    await prisma.notificationDelivery.update({
      where: { id },
      data: { mailKeyVersion: before.mailKeyVersion },
    });
    await due(id);
    expect(await processNext(second)).toEqual({ outcome: 'SENT' });
  });

  it('authenticated envelope rejects a swapped recipient and makes no HTTP attempt', async () => {
    const id = await enqueue();
    await prisma.notificationDelivery.update({
      where: { id },
      data: { recipient: 'tampered@mail-queue.example.edu' },
    });
    expect(await processNext()).toEqual({ outcome: 'FAILED' });
    expect(await row(id)).toMatchObject({
      failureCode: 'MAIL_ENVELOPE_INVALID',
      mailPayload: null,
    });
    expect(calls).toHaveLength(0);
  });

  it('expires queued work under an unknown key without decrypting or sending it', async () => {
    const id = await enqueue();
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        mailQueuedAt: new Date((await databaseNow()) - 3600000),
        mailExpiresAt: new Date((await databaseNow()) - 1000),
        mailKeyVersion: 99,
      },
    });
    expect(await processNext()).toEqual({ outcome: 'FAILED' });
    expect(await row(id)).toMatchObject({
      failureCode: 'MAIL_DELIVERY_EXPIRED',
      mailPayload: null,
      mailAttemptCount: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('completion snapshot commits atomically with anonymization and delivers to the original email', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: {
        status: 'DELETION_SCHEDULED',
        deletionScheduledAt: new Date((await databaseNow()) - 1000),
      },
    });
    expect(
      await first.get(AccountDeletionFinalizationService).finalizeBatch(),
    ).toBe(1);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status,
    ).toBe('DELETED');
    const job = await prisma.notificationDelivery.findFirstOrThrow({
      where: { userId, type: 'ACCOUNT_DELETED' },
    });
    expect(job).toMatchObject({
      status: 'PENDING',
      recipient: email,
      attemptedAt: null,
    });
    expect(calls).toHaveLength(0);
    expect(await processNext()).toEqual({ outcome: 'SENT' });
    expect(calls[0].recipient).toBe(email);
  });

  it('completion enqueue rolls back with its business transaction', async () => {
    const key = randomUUID();
    await expect(
      prisma.$transaction(async (tx) => {
        await first
          .get(AccountDeletionNotificationService)
          .prepareDeletionCompleted(tx, {
            userId,
            securityEventId: key,
            recipient: email,
            occurredAt: new Date(),
          });
        throw new Error('Controlled rollback');
      }),
    ).rejects.toThrow('Controlled rollback');
    expect(
      await prisma.notificationDelivery.count({
        where: { idempotencyKey: `ACCOUNT_DELETED:${key}` },
      }),
    ).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('preserves ACCEPTED when pressure persistence fails after HTTP', async () => {
    const id = await enqueue();
    breakPressure = true;
    headers = { 'retry-after': '30' };
    expect(await processNext()).toEqual({ outcome: 'SENT' });
    expect((await row(id)).status).toBe('SENT');
    expect(calls).toHaveLength(1);
    const other = await enqueue();
    expect((await worker.runOnce())[0].outcome).toBe('DEFERRED');
    expect((await row(other)).mailAttemptCount).toBe(0);
  });

  it('rolls back a failed SQL attempt-start while leaving the committed gate permission spent', async () => {
    const id = await enqueue();
    await prisma.$executeRaw`CREATE FUNCTION mail_queue_start_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."mailAttemptStarted" AND NOT OLD."mailAttemptStarted" THEN RAISE EXCEPTION 'Injected failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`;
    await prisma.$executeRaw`CREATE TRIGGER mail_queue_start_fault BEFORE UPDATE ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION mail_queue_start_fault()`;
    try {
      expect(await processNext()).toEqual({ outcome: 'DEFERRED' });
      expect(calls).toHaveLength(0);
      expect(await row(id)).toMatchObject({
        mailAttemptCount: 0,
        attemptedAt: null,
        status: 'PENDING',
        mailLeaseId: null,
      });
      expect(
        await prisma.gcraRateLimit.findUnique({
          where: { key: MAIL_SUBMISSION_GATE.key },
        }),
      ).not.toBeNull();
    } finally {
      await prisma.$executeRaw`DROP TRIGGER mail_queue_start_fault ON "NotificationDelivery"`;
      await prisma.$executeRaw`DROP FUNCTION mail_queue_start_fault()`;
    }
  });

  it('auth delivery shares a notification-imposed provider pause without creating another auth queue', async () => {
    await enqueue();
    status = 429;
    errorName = 'rate_limit_exceeded';
    headers = { 'retry-after': '30' };
    await processNext();
    const challengeId = randomUUID();
    const proofFactory = first.get(AuthenticationChallengeProofFactoryService);
    const proof = proofFactory.generate({
      challengeId,
      purpose: 'SIGN_IN',
      normalizedIdentity: email,
    });
    await prisma.authenticationChallenge.create({
      data: {
        id: challengeId,
        subject: { create: { key: `${prefix}${challengeId}` } },
        identityType: 'INSTITUTIONAL_EMAIL',
        normalizedIdentity: email,
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
        expiresAt: new Date((await databaseNow()) + 600000),
        retentionExpiresAt: new Date((await databaseNow()) + 86400000),
      },
    });
    const auth = await prisma.authenticationChallengeDelivery.create({
      data: {
        challengeId,
        method: 'EMAIL',
        origin: 'INITIAL',
        recipientSnapshot: email,
        idempotencyKey: randomUUID(),
        templateProtocolVersion: 1,
        retentionExpiresAt: new Date((await databaseNow()) + 86400000),
      },
    });
    const authRepository = second.get(AuthenticationDeliveryRepository),
      claim = (await authRepository.claimNextDelivery())!;
    expect(
      (
        await second
          .get(AuthenticationDeliveryOrchestrationService)
          .process(claim)
      ).outcome,
    ).toBe('DEFERRED');
    expect(
      (
        await prisma.authenticationChallengeDelivery.findUniqueOrThrow({
          where: { id: auth.id },
        })
      ).attemptCount,
    ).toBe(0);
    expect(
      await prisma.notificationDelivery.count({ where: { recipient: email } }),
    ).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('uses fresh proof state after an actual gate-lock wait', async () => {
    const token = 'reset-before-gate',
      record = await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date((await databaseNow()) + 600000),
        },
      });
    await mail.sendPasswordResetRequestEmail(
      {
        recipient: email,
        idempotencyKey: `PASSWORD_RESET_REQUEST:${record.id}`,
        token,
        tokenId: record.id,
        userId,
        expiresInSeconds: 600,
      },
      { userId },
    );
    const claim = (await repository.claimNext())!;
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      unlock = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holding = prisma.$transaction(
      async (tx) => {
        await first
          .get(GcraAdmissionRepository)
          .lockAliases(tx, [MAIL_SUBMISSION_GATE.key]);
        ready();
        await unlock;
      },
      { timeout: 10000 },
    );
    let pending: ReturnType<typeof worker.process> | undefined;
    try {
      await locked;
      pending = worker.process(claim);
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
      await prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      });
      release();
      await holding;
      expect(await pending).toEqual({ outcome: 'FAILED' });
      expect(calls).toHaveLength(0);
    } finally {
      release();
      await Promise.allSettled(pending ? [holding, pending] : [holding]);
    }
  });
  it('keeps an accepted-but-unrecorded send leased and recovers with the identical provider key and payload', async () => {
    const id = await enqueue();
    await prisma.$executeRaw`CREATE FUNCTION mail_queue_sent_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."status"='SENT' THEN RAISE EXCEPTION 'Injected acknowledgement persistence failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$`;
    await prisma.$executeRaw`CREATE TRIGGER mail_queue_sent_fault BEFORE UPDATE ON "NotificationDelivery" FOR EACH ROW EXECUTE FUNCTION mail_queue_sent_fault()`;
    try {
      await expect(processNext()).rejects.toBeDefined();
      expect(await row(id)).toMatchObject({
        status: 'PENDING',
        mailAttemptCount: 1,
        failureCode: null,
        mailAttemptStarted: true,
      });
      expect(calls).toHaveLength(1);
    } finally {
      await prisma.$executeRaw`DROP TRIGGER mail_queue_sent_fault ON "NotificationDelivery"`;
      await prisma.$executeRaw`DROP FUNCTION mail_queue_sent_fault()`;
    }
    await prisma.notificationDelivery.update({
      where: { id },
      data: { mailLeaseExpiresAt: new Date((await databaseNow()) - 1000) },
    });
    await waitPermission();
    expect(await processNext(second)).toEqual({ outcome: 'SENT' });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect((await row(id)).mailAttemptCount).toBe(2);
  });

  it('does not claim that historical pending metadata without a snapshot is newly queued', async () => {
    const input = notification();
    const historical = await prisma.notificationDelivery.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        type: 'NEW_SESSION',
        channel: 'EMAIL',
        recipient: email,
        retentionExpiresAt: new Date((await databaseNow()) + 86400000),
      },
    });
    await expect(mail.sendNewSessionEmail(input, { userId })).rejects.toThrow();
    expect(await row(historical.id)).toEqual(historical);
    expect(await repository.claimNext()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('treats an unknown 4xx conservatively as ambiguous rather than assuming non-delivery', async () => {
    const id = await enqueue();
    status = 400;
    errorName = 'unknown_error';
    expect(await processNext()).toEqual({ outcome: 'RETRY_SCHEDULED' });
    expect(await row(id)).toMatchObject({
      status: 'PENDING',
      mailAttemptCount: 1,
      failureCode: 'MAIL_PROVIDER_OUTCOME_UNKNOWN',
    });
  });

  it('migration preserves historical rows without inventing payloads and rejects partial envelopes', async () => {
    const schema = `notification_queue_migration_${randomUUID().replaceAll('-', '')}`;
    const migration = readFileSync(
      resolve(
        __dirname,
        '../prisma/migrations/20261112050000_add_durable_notification_mail/migration.sql',
      ),
      'utf8',
    );
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRaw`SELECT set_config('search_path', ${schema}, true)`;
      await tx.$executeRaw`CREATE TYPE "NotificationType" AS ENUM ('NEW_SESSION')`;
      await tx.$executeRaw`CREATE TABLE "NotificationDelivery" ("id" text PRIMARY KEY, "idempotencyKey" text, "status" text NOT NULL, "retentionExpiresAt" timestamp NOT NULL)`;
      await tx.$executeRaw`INSERT INTO "NotificationDelivery" VALUES ('pending','old-key','PENDING',now()),('sent','sent-key','SENT',now()),('failed','failed-key','FAILED',now())`;
      const before = await tx.$queryRaw<
        { id: string; status: string }[]
      >`SELECT "id", "status" FROM "NotificationDelivery" ORDER BY "id"`;
      for (const sql of migration
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean))
        await tx.$executeRawUnsafe(sql);
      const after = await tx.$queryRaw<
        {
          id: string;
          status: string;
          mailQueuedAt: Date | null;
          mailPayload: Uint8Array | null;
          mailAttemptCount: number;
        }[]
      >`SELECT "id", "status", "mailQueuedAt", "mailPayload", "mailAttemptCount" FROM "NotificationDelivery" ORDER BY "id"`;
      expect(after).toEqual(
        before.map((item) => ({
          ...item,
          mailQueuedAt: null,
          mailPayload: null,
          mailAttemptCount: 0,
        })),
      );
      await tx.$executeRaw`SAVEPOINT mail_envelope_invalid`;
      await expect(
        tx.$executeRaw`UPDATE "NotificationDelivery" SET "mailPayload"=decode('01','hex') WHERE "id"='pending'`,
      ).rejects.toMatchObject({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '23514' } } },
      });
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT mail_envelope_invalid`;
      await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    });
  });
  it('integrates admitted auth and notification sends across replicas without recharging admission', async () => {
    const auth = await admittedAuth(),
      mailId = await enqueue();
    const budget = await admissionSnapshot();
    expect(budget.rates.length).toBeGreaterThan(0);
    expect(budget.cooldowns.length).toBeGreaterThan(0);
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: auth.challengeId },
    });
    await drainBoth(auth.id, mailId);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.key))).toEqual(
      new Set([(await authRow(auth.id)).idempotencyKey, mailId]),
    );
    expect((await authRow(auth.id)).attemptCount).toBe(1);
    expect((await row(mailId)).mailAttemptCount).toBe(1);
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: auth.challengeId },
      }),
    ).toEqual(challenge);
    expect(await admissionSnapshot()).toEqual(budget);
  });

  it('auth-imposed Retry-After stops both queues and timed recovery preserves proof, keys and admission debt', async () => {
    const auth = await admittedAuth();
    const budget = await admissionSnapshot();
    const challenge = await prisma.authenticationChallenge.findUniqueOrThrow({
      where: { id: auth.challengeId },
    });
    status = 429;
    errorName = 'rate_limit_exceeded';
    headers = { 'retry-after': '1' };
    expect(await runAuth()).toEqual({ outcome: 'RETRY_SCHEDULED' });
    const firstAttempt = await authRow(auth.id),
      mailId = await enqueue();
    const pressure = await prisma.mailProviderPressure.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(
      (await second.get(MailDeliveryWorkerService).runOnce())[0],
    ).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: pressure.retryNotBeforeMicros,
    });
    expect(await row(mailId)).toMatchObject({
      mailAttemptCount: 0,
      attemptedAt: null,
      failureCode: null,
    });
    expect(await authRow(auth.id)).toEqual(firstAttempt);
    expect(calls).toHaveLength(1);
    status = 200;
    headers = {};
    // Wait for actual persisted auth policy backoff, not a reset/frozen-clock fixture.
    await waitUntil(
      Math.max(
        firstAttempt.nextAttemptAt!.getTime(),
        (await row(mailId)).mailNextAttemptAt!.getTime(),
      ),
    );
    await drainBoth(auth.id, mailId);
    const authCalls = calls.filter(
      (call) => call.key === firstAttempt.idempotencyKey,
    );
    expect(authCalls).toHaveLength(2);
    expect(authCalls[1]).toEqual(authCalls[0]);
    expect(calls).toHaveLength(3);
    expect((await authRow(auth.id)).attemptCount).toBe(2);
    expect((await row(mailId)).mailAttemptCount).toBe(1);
    expect(await admissionSnapshot()).toEqual(budget);
    expect(
      await prisma.authenticationChallenge.findUniqueOrThrow({
        where: { id: auth.challengeId },
      }),
    ).toEqual(challenge);
    expect(
      await prisma.mailProviderPressure.findUniqueOrThrow({ where: { id: 1 } }),
    ).toEqual(pressure);
  });

  it('terminalization and cleanup progress for both queues during monthly pause without erasing active debt', async () => {
    const auth = await admittedAuth(),
      mailId = await enqueue();
    const budget = await admissionSnapshot();
    const pressureService = first.get(MailProviderPressureService);
    await pressureService.observe({
      statusCode: 429,
      errorName: 'monthly_quota_exceeded',
      headers: {},
    });
    const pressure = await prisma.mailProviderPressure.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect((await runAuth())?.outcome).toBe('DEFERRED');
    expect((await worker.runOnce())[0].outcome).toBe('DEFERRED');
    const now = await databaseNow();
    await prisma.authenticationChallenge.update({
      where: { id: auth.challengeId },
      data: {
        consumedAt: new Date(now),
        encryptedProof: null,
        proofEncryptionIv: null,
        proofEncryptionTag: null,
      },
    });
    await prisma.authenticationChallengeDelivery.update({
      where: { id: auth.id },
      data: { retentionExpiresAt: new Date(now - 1000) },
    });
    // Explicit expired-history fixture: production enqueue never rewrites this bound/AAD.
    await prisma.notificationDelivery.update({
      where: { id: mailId },
      data: {
        mailQueuedAt: new Date(now - 3600000),
        mailExpiresAt: new Date(now - 2000),
        retentionExpiresAt: new Date(now - 1000),
      },
    });
    expect(await runAuth(second)).toEqual({ outcome: 'CANCELLED' });
    expect(await processNext()).toEqual({ outcome: 'FAILED' });
    expect((await authRow(auth.id)).attemptCount).toBe(0);
    expect((await row(mailId)).mailAttemptCount).toBe(0);
    expect(
      await first
        .get(AuthenticationDeliveryCleanupRepository)
        .deleteOneRetainedTerminalBatch(10),
    ).toBe(1);
    expect(
      await first
        .get(NotificationDeliveryService)
        .deleteExpired(new Date(await databaseNow())),
    ).toBe(1);
    expect(
      await prisma.authenticationChallengeDelivery.findUnique({
        where: { id: auth.id },
      }),
    ).toBeNull();
    expect(
      await prisma.notificationDelivery.findUnique({ where: { id: mailId } }),
    ).toBeNull();
    expect(await admissionSnapshot()).toEqual(budget);
    expect(calls).toHaveLength(0);
    expect(
      await prisma.mailProviderPressure.findUniqueOrThrow({ where: { id: 1 } }),
    ).toEqual(pressure);
  });

  it('both queues fail closed on shared gate infrastructure loss and resume without losing or recharging work', async () => {
    const auth = await admittedAuth(),
      mailId = await enqueue();
    const budget = await admissionSnapshot();
    const pressure = await prisma.mailProviderPressure.findUniqueOrThrow({
      where: { id: 1 },
    });
    await prisma.mailProviderPressure.delete({ where: { id: 1 } });
    expect((await runAuth())?.outcome).toBe('DEFERRED');
    expect(
      (await second.get(MailDeliveryWorkerService).runOnce())[0].outcome,
    ).toBe('DEFERRED');
    expect((await authRow(auth.id)).attemptCount).toBe(0);
    expect((await row(mailId)).mailAttemptCount).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await admissionSnapshot()).toEqual(budget);
    // Controlled infrastructure repair; runtime gate must never recreate missing state.
    await prisma.mailProviderPressure.create({ data: pressure });
    await waitUntil(
      Math.max(
        (await authRow(auth.id)).nextAttemptAt!.getTime(),
        (await row(mailId)).mailNextAttemptAt!.getTime(),
      ),
    );
    await drainBoth(auth.id, mailId);
    expect(calls).toHaveLength(2);
    expect(await admissionSnapshot()).toEqual(budget);
    expect((await authRow(auth.id)).attemptCount).toBe(1);
    expect((await row(mailId)).mailAttemptCount).toBe(1);
  });
  it('cleanup preserves an in-flight leased notification until its known acceptance is recorded', async () => {
    const id = await enqueue(),
      original = await row(id);
    const encryption = first.get(MailDeliveryEncryptionService);
    const payload = encryption.decrypt(original);
    const now = await databaseNow(),
      deadline = new Date(now + 1500);
    // Historical-time fixture with a real authenticated envelope; no runtime
    // expiry or lease policy is changed and no clock/service is mocked.
    await prisma.notificationDelivery.update({
      where: { id },
      data: {
        mailQueuedAt: new Date(now - 3600000),
        mailExpiresAt: deadline,
        retentionExpiresAt: deadline,
        ...encryption.encrypt(
          { ...original, mailExpiresAt: deadline },
          payload,
        ),
      },
    });
    let release!: () => void;
    holdResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = (await repository.claimNext())!;
    const pending = worker.process(claim);
    void pending.catch(() => undefined);
    try {
      for (let i = 0; i < 100 && calls.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toHaveLength(1);
      const sending = await row(id);
      expect(sending).toMatchObject({
        mailAttemptStarted: true,
        mailAttemptCount: 1,
        status: 'PENDING',
      });
      const gate = await prisma.gcraRateLimit.findUniqueOrThrow({
        where: { key: MAIL_SUBMISSION_GATE.key },
      });
      const cleanup = first.get(NotificationDeliveryService);
      // Retention cutoff is an input, not authority to revoke a DB-active lease.
      expect(
        await cleanup.deleteExpired(new Date(deadline.getTime() + 60000)),
      ).toBe(0);
      await waitUntil(deadline.getTime() + 5);
      expect(await cleanup.deleteExpired(new Date(await databaseNow()))).toBe(
        0,
      );
      expect(await row(id)).toEqual(sending);
      release();
      expect(await pending).toEqual({ outcome: 'SENT' });
      expect(await row(id)).toMatchObject({
        status: 'SENT',
        mailAttemptCount: 1,
        mailPayload: null,
        mailLeaseId: null,
      });
      expect(await cleanup.deleteExpired(new Date(await databaseNow()))).toBe(
        1,
      );
      expect(
        await prisma.notificationDelivery.findUnique({ where: { id } }),
      ).toBeNull();
      expect(
        await prisma.gcraRateLimit.findUnique({
          where: { key: MAIL_SUBMISSION_GATE.key },
        }),
      ).toEqual(gate);
    } finally {
      release();
      await Promise.allSettled([pending]);
      holdResponse = undefined;
    }
  });
});
