import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { validateEnvironment } from '../src/config/environment.validation';
import { MailModule } from '../src/mail/mail.module';
import { MAIL_SUBMISSION_GATE } from '../src/mail/constants/mail-submission-gate.constants';
import { MailProviderPressureRepository } from '../src/mail/repositories/mail-provider-pressure.repository';
import { MailProviderPressureService } from '../src/mail/services/mail-provider-pressure.service';
import { MailSubmissionGateConfigService } from '../src/mail/services/mail-submission-gate-config.service';
import { MailSubmissionGateService } from '../src/mail/services/mail-submission-gate.service';
import { ResendMailHttpClient } from '../src/mail/services/resend-mail-http-client.service';
import { ResendMailTransportService } from '../src/mail/services/resend-mail-transport.service';
import type { MailSubmission } from '../src/mail/types/mail-submission.type';
import { UTC_DAY_MICROS } from '../src/mail/utils/mail-provider-pressure.util';
import { PrismaService } from '../src/prisma/prisma.service';
import { GcraAdmissionRepository } from '../src/rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../src/rate-limit/services/gcra-admission-config.service';

// Real database services and actual HTTP, no mocked repositories, transactions,
// clocks or provider services. Only the network destination is a local server.
describe('Shared mail pressure and transport (PostgreSQL + HTTP)', () => {
  jest.setTimeout(20_000);
  let module: TestingModule, prisma: PrismaService, replica: PrismaService;
  let pressure: MailProviderPressureService,
    secondPressure: MailProviderPressureService;
  let gate: MailSubmissionGateService, secondGate: MailSubmissionGateService;
  let transport: ResendMailTransportService, gcra: GcraAdmissionRepository;
  let server: Server, endpoint: string;
  let status = 200,
    errorName: string | undefined;
  let headers: Record<string, string> = {};
  let calls: { url?: string; key?: string; body: Record<string, unknown> }[] =
    [];
  let breakObservation = false,
    disconnect = false;
  const submission: MailSubmission = {
    idempotencyKey: 'mail-pressure-stable-key',
    content: {
      from: 'Unicon <noreply@example.edu>',
      recipient: 'student@example.edu',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
      inlineAttachments: [],
    },
  };
  class LocalResendHttpClient extends ResendMailHttpClient {
    protected readonly endpoint = endpoint;
  }
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void (async () => {
          calls.push({
            url: request.url,
            key: request.headers['idempotency-key'] as string,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
              string,
              unknown
            >,
          });
          // Real SQL failure after the provider observed the request.
          if (breakObservation)
            await prisma.mailProviderPressure.delete({ where: { id: 1 } });
          if (disconnect) {
            response.destroy();
            return;
          }
          response.writeHead(status, {
            'content-type': 'application/json',
            ...headers,
          });
          response.end(
            JSON.stringify(
              status < 300 ? { id: 'local-provider-id' } : { name: errorName },
            ),
          );
        })().catch(() => response.destroy());
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/emails`;
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnvironment,
        }),
        MailModule,
      ],
    })
      .overrideProvider(ResendMailHttpClient)
      .useClass(LocalResendHttpClient)
      .compile();
    prisma = module.get(PrismaService);
    const url = new URL(
      module.get(ConfigService).getOrThrow<string>('DATABASE_URL'),
    );
    if (!url.pathname.endsWith('_test'))
      throw new Error('Dedicated test database required.');
    url.searchParams.set('application_name', 'mail_pressure_replica');
    replica = new PrismaService(
      new ConfigService({ DATABASE_URL: url.toString() }),
    );
    await replica.$connect();
    gcra = module.get(GcraAdmissionRepository);
    const repository = module.get(MailProviderPressureRepository),
      bounds = module.get(GcraAdmissionConfigService);
    pressure = module.get(MailProviderPressureService);
    secondPressure = new MailProviderPressureService(
      replica,
      gcra,
      repository,
      bounds,
      module.get(ConfigService),
    );
    gate = module.get(MailSubmissionGateService);
    secondGate = new MailSubmissionGateService(
      replica,
      gcra,
      module.get(MailSubmissionGateConfigService),
      bounds,
      repository,
    );
    transport = module.get(ResendMailTransportService);
  });
  async function reset() {
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
    status = 200;
    errorName = undefined;
    headers = {};
    calls = [];
    breakObservation = false;
    disconnect = false;
  });
  afterEach(reset);
  afterAll(async () => {
    await replica?.$disconnect();
    await module?.close();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  function state() {
    return prisma.mailProviderPressure.findUniqueOrThrow({ where: { id: 1 } });
  }
  function send(key = submission.idempotencyKey) {
    return transport.send(
      { ...submission, idempotencyKey: key },
      AbortSignal.timeout(5000),
    );
  }

  it('sends one HTTP request after commit, with stable idempotency and only content fields', async () => {
    expect(await send()).toMatchObject({
      outcome: 'ACCEPTED',
      providerMessageId: 'local-provider-id',
      pressurePersistence: 'NOT_REQUIRED',
    });
    expect(calls).toEqual([
      {
        url: '/emails',
        key: submission.idempotencyKey,
        body: {
          from: submission.content.from,
          to: [submission.content.recipient],
          subject: 'Test',
          html: '<p>Test</p>',
          text: 'Test',
          attachments: [],
        },
      },
    ]);
    expect((await state()).revision).toBe(0n);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).not.toBeNull();
  });
  it('persists a 429 pause across replicas and different messages without charging a second permission', async () => {
    status = 429;
    errorName = 'rate_limit_exceeded';
    headers = { 'retry-after': '30' };
    expect(await send()).toMatchObject({
      outcome: 'REJECTED',
      providerRestriction: 'RATE_LIMIT',
      pressurePersistence: 'RECORDED',
    });
    const paused = await state(),
      permission = await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      });
    expect(await secondGate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: paused.retryNotBeforeMicros,
    });
    expect(await send('different-message-key')).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: paused.retryNotBeforeMicros,
    });
    expect(calls).toHaveLength(1);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).toEqual(permission);
    expect(await state()).toEqual(paused);
  });
  it.each([{}, { 'retry-after': 'invalid' }])(
    'uses the configured fallback for a 429 with %p',
    async (responseHeaders) => {
      const before = await gcra.operationNowMicros(prisma);
      await pressure.observe({ statusCode: 429, headers: responseHeaders });
      const after = await gcra.operationNowMicros(prisma),
        row = await state();
      expect(row.retryNotBeforeMicros).toBeGreaterThanOrEqual(
        before + 1_000_000n,
      );
      expect(row.retryNotBeforeMicros).toBeLessThanOrEqual(after + 1_000_000n);
    },
  );
  it('never shortens the persisted boundary under concurrent responses', async () => {
    await pressure.observe({
      statusCode: 429,
      headers: { 'retry-after': '3600' },
    });
    const boundary = (await state()).retryNotBeforeMicros;
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? pressure : secondPressure).observe({
          statusCode: 429,
          headers: { 'retry-after': '1' },
        }),
      ),
    );
    expect((await state()).retryNotBeforeMicros).toBe(boundary);
    expect((await state()).revision).toBe(13n);
    expect(await secondGate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: boundary,
    });
  });
  it('daily quota waits until UTC midnight and respects a later Retry-After', async () => {
    const before = await gcra.operationNowMicros(prisma);
    await pressure.observe({
      statusCode: 429,
      errorName: 'daily_quota_exceeded',
      headers: {},
    });
    const after = await gcra.operationNowMicros(prisma),
      row = await state();
    expect(row.dailyNotBeforeMicros).toBeGreaterThan(before);
    expect(row.dailyNotBeforeMicros).toBeLessThanOrEqual(
      (after / UTC_DAY_MICROS + 1n) * UTC_DAY_MICROS,
    );
    expect(row.dailyNotBeforeMicros % UTC_DAY_MICROS).toBe(0n);
    expect(await gate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: row.dailyNotBeforeMicros,
    });
    await secondPressure.observe({
      statusCode: 429,
      errorName: 'daily_quota_exceeded',
      headers: { 'retry-after': '172800' },
    });
    const extended = await state();
    expect(extended.retryNotBeforeMicros).toBeGreaterThan(
      extended.dailyNotBeforeMicros,
    );
    expect(await gate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: extended.retryNotBeforeMicros,
    });
  });
  it('monthly quota requires explicit recovery and a stale revision cannot clear newer pressure', async () => {
    status = 429;
    errorName = 'monthly_quota_exceeded';
    expect(await send()).toMatchObject({
      providerRestriction: 'MONTHLY_QUOTA',
      pressurePersistence: 'RECORDED',
    });
    const old = await state();
    expect(await secondGate.tryAcquire()).toMatchObject({
      outcome: 'PAUSED',
      reason: 'MONTHLY_QUOTA',
    });
    await secondPressure.observe({
      statusCode: 429,
      errorName: 'monthly_quota_exceeded',
      headers: { 'retry-after': '30' },
    });
    expect(await pressure.clearMonthlyBlock(old.revision)).toBe(false);
    const current = await state();
    expect(await pressure.clearMonthlyBlock(current.revision)).toBe(true);
    expect(await gate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: current.retryNotBeforeMicros,
    });
    expect(await send('another-key')).toMatchObject({ outcome: 'DEFERRED' });
    expect(calls).toHaveLength(1);
  });
  it('recovers after an actual elapsed boundary without resetting state or accumulating a burst', async () => {
    const boundary = (await gcra.operationNowMicros(prisma)) + 300_000n;
    await prisma.mailProviderPressure.update({
      where: { id: 1 },
      data: { retryNotBeforeMicros: boundary, dailyNotBeforeMicros: boundary },
    });
    expect(await gate.tryAcquire()).toMatchObject({ outcome: 'DEFERRED' });
    await prisma.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(${boundary.toString()}::numeric-EXTRACT(EPOCH FROM clock_timestamp())*1000000)/1000000)::double precision)`;
    const result = await secondGate.tryAcquire();
    expect(result.outcome).toBe('GRANTED');
    expect(result.operationNowMicros).toBeGreaterThanOrEqual(boundary);
    expect((await state()).retryNotBeforeMicros).toBe(boundary);
  });
  it('records Retry-After from a 503 as shared pressure without claiming a known delivery outcome', async () => {
    status = 503;
    headers = { 'retry-after': '60' };
    expect(await send()).toMatchObject({
      outcome: 'REJECTED',
      statusCode: 503,
      providerRestriction: null,
      pressurePersistence: 'RECORDED',
    });
    expect(await secondGate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: (await state()).retryNotBeforeMicros,
    });
  });
  it.each([200, 429])(
    'preserves the provider response when pressure persistence fails after HTTP %s',
    async (code) => {
      status = code;
      errorName = 'rate_limit_exceeded';
      headers = { 'retry-after': '30' };
      breakObservation = true;
      expect(await send()).toMatchObject({
        outcome: code === 200 ? 'ACCEPTED' : 'REJECTED',
        pressurePersistence: 'FAILED',
      });
      expect(calls).toHaveLength(1);
      await expect(secondGate.tryAcquire()).rejects.toMatchObject({
        reason: 'INVALID_STATE',
      });
      expect(calls).toHaveLength(1);
    },
  );
  it('fails closed before HTTP when the singleton is missing', async () => {
    await prisma.mailProviderPressure.delete({ where: { id: 1 } });
    await expect(send()).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(calls).toHaveLength(0);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).toBeNull();
  });
  it('does not retry a disconnected HTTP request and keeps the committed permission spent', async () => {
    disconnect = true;
    expect(await send()).toEqual({
      outcome: 'OUTCOME_UNKNOWN',
      safeFailureCode: 'RESEND_TRANSPORT_OUTCOME_UNKNOWN',
    });
    expect(calls).toHaveLength(1);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).not.toBeNull();
  });
  it('does not send or charge an already cancelled caller', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      transport.send(submission, controller.signal),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
    expect(
      await prisma.gcraRateLimit.findUnique({
        where: { key: MAIL_SUBMISSION_GATE.key },
      }),
    ).toBeNull();
  });
  it('samples observation time after a real shared advisory-lock wait', async () => {
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const unlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = prisma.$transaction(
      async (tx) => {
        await gcra.lockAliases(tx, [MAIL_SUBMISSION_GATE.key]);
        ready();
        await unlock;
      },
      { timeout: 10000 },
    );
    let pending: Promise<void> | undefined;
    try {
      await locked;
      pending = secondPressure.observe({
        statusCode: 429,
        headers: { 'retry-after': '5' },
      });
      void pending.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const rows = await prisma.$queryRaw<
          { pid: number }[]
        >`SELECT pid FROM pg_stat_activity WHERE application_name='mail_pressure_replica' AND wait_event_type='Lock'`;
        if (rows.length) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(0.2)`;
      const beforeRelease = await gcra.operationNowMicros(prisma);
      release();
      await holding;
      await pending;
      expect((await state()).retryNotBeforeMicros).toBeGreaterThanOrEqual(
        beforeRelease + 5_000_000n,
      );
    } finally {
      release();
      await Promise.allSettled(pending ? [holding, pending] : [holding]);
    }
  });

  it.each(['23514', '40001', '40P01'])(
    'rolls back real SQL failure %s and retries only confirmed aborts',
    async (sqlstate) => {
      // Sequence advancement survives rollback and proves how many writes ran.
      await prisma.$executeRaw`CREATE SEQUENCE mail_pressure_fault_calls`;
      await prisma.$executeRawUnsafe(`CREATE FUNCTION mail_pressure_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF nextval('mail_pressure_fault_calls') = 1 THEN RAISE EXCEPTION 'Injected private failure' USING ERRCODE = '${sqlstate}'; END IF;
      RETURN NEW; END $$`);
      await prisma.$executeRaw`CREATE TRIGGER mail_pressure_fault BEFORE UPDATE ON "MailProviderPressure" FOR EACH ROW EXECUTE FUNCTION mail_pressure_fault()`;
      try {
        const before = await state();
        const operation = pressure.observe({
          statusCode: 429,
          errorName: 'monthly_quota_exceeded',
          headers: { 'retry-after': '60' },
        });
        if (sqlstate === '23514') {
          await expect(operation).rejects.toMatchObject({
            reason: 'STATE_UNAVAILABLE',
          });
          expect(await state()).toEqual(before);
        } else {
          await operation;
          expect(await state()).toMatchObject({
            monthlyBlocked: true,
            revision: 1n,
          });
        }
        const [row] = await prisma.$queryRaw<
          { last_value: bigint }[]
        >`SELECT last_value FROM mail_pressure_fault_calls`;
        expect(row.last_value).toBe(sqlstate === '23514' ? 1n : 2n);
      } finally {
        await prisma.$executeRaw`DROP TRIGGER mail_pressure_fault ON "MailProviderPressure"`;
        await prisma.$executeRaw`DROP FUNCTION mail_pressure_fault()`;
        await prisma.$executeRaw`DROP SEQUENCE mail_pressure_fault_calls`;
      }
    },
  );

  it('persists an absolute HTTP-date boundary exactly and preserves it against an earlier response', async () => {
    const now = await gcra.operationNowMicros(prisma);
    const milliseconds = Number(now / 1000n) + 120000;
    const retryAt = new Date(milliseconds).toUTCString();
    const boundary = BigInt(Date.parse(retryAt)) * 1000n;
    await pressure.observe({
      statusCode: 503,
      headers: { 'Retry-After': retryAt },
    });
    expect((await state()).retryNotBeforeMicros).toBe(boundary);
    await secondPressure.observe({
      statusCode: 429,
      headers: { 'retry-after': '0' },
    });
    expect(await gate.tryAcquire()).toMatchObject({
      outcome: 'DEFERRED',
      retryNotBeforeMicros: boundary,
    });
  });
});
