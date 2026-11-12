import { ConfigService } from '@nestjs/config';

import { Prisma, type GcraRateLimit } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { GcraAdmissionRepository } from '../../rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../../rate-limit/services/gcra-admission-config.service';
import { createGcraState } from '../../rate-limit/utils/gcra-state.util';
import { toGcraPersistenceData } from '../../rate-limit/utils/gcra-state-persistence.util';
import { MailProviderPressureRepository } from '../repositories/mail-provider-pressure.repository';
import { MAIL_SUBMISSION_GATE as gate } from '../constants/mail-submission-gate.constants';
import { MailSubmissionGateConfigService } from './mail-submission-gate-config.service';
import { MailSubmissionGateService } from './mail-submission-gate.service';

function setup(now = 1000n, rate = 8) {
  const config = new ConfigService({
    MAIL_RESEND_SUBMISSIONS_PER_SECOND: rate,
    MAIL_RESEND_TEAM_REQUESTS_PER_SECOND: 10,
    RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
    RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 5,
    RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 2,
  });
  const repository = {
    lockAliases: jest.fn().mockResolvedValue(undefined),
    readAliases: jest
      .fn<
        Promise<GcraRateLimit[]>,
        [Prisma.TransactionClient, readonly string[]]
      >()
      .mockResolvedValue([]),
    operationNowMicros: jest.fn().mockResolvedValue(now),
    writeAliases: jest.fn().mockResolvedValue(undefined),
  };
  const transactions: Prisma.TransactionClient[] = [];
  const prisma = {
    $transaction: jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
        const tx = {
          $executeRaw: jest.fn().mockResolvedValue(0),
        } as unknown as Prisma.TransactionClient;
        transactions.push(tx);
        return work(tx);
      },
    ),
  };
  const pressureState = {
    id: 1,
    retryNotBeforeMicros: 0n,
    dailyNotBeforeMicros: 0n,
    monthlyBlocked: false,
    revision: 0n,
  };
  const pressure = { read: jest.fn().mockResolvedValue(pressureState) };
  const service = new MailSubmissionGateService(
    prisma as unknown as PrismaService,
    repository as unknown as GcraAdmissionRepository,
    new MailSubmissionGateConfigService(config),
    new GcraAdmissionConfigService(config),
    pressure as unknown as MailProviderPressureRepository,
  );
  return { service, repository, prisma, transactions, pressure };
}
function row(
  tat: bigint,
  overrides: Partial<GcraRateLimit> = {},
): GcraRateLimit {
  const data = toGcraPersistenceData(
    createGcraState(
      { numerator: tat, denominator: 1n },
      { burst: 1, rate: 8, periodSeconds: 1 },
    ),
  );
  return {
    key: gate.key,
    policyId: gate.policyId,
    ...data,
    tatNumerator: new Prisma.Decimal(data.tatNumerator),
    tatDenominator: new Prisma.Decimal(data.tatDenominator),
    idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
    updatedAt: new Date(0),
    ...overrides,
  };
}
function abort() {
  return new Prisma.PrismaClientKnownRequestError('Private abort detail.', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

describe('MailSubmissionGateService (unit orchestration)', () => {
  it('owns a bounded ReadCommitted transaction, locks before time sampling and persists one permission', async () => {
    const { service, repository, prisma, transactions } = setup();
    expect(await service.tryAcquire()).toEqual({
      outcome: 'GRANTED',
      operationNowMicros: 1000n,
      nextPermissionNotBeforeMicros: 126000n,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 5000,
      maxWait: 2000,
    });
    expect(repository.lockAliases).toHaveBeenCalledWith(transactions[0], [
      gate.key,
    ]);
    expect(repository.readAliases).toHaveBeenCalledWith(transactions[0], [
      gate.key,
    ]);
    expect(repository.lockAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.readAliases.mock.invocationCallOrder[0],
    );
    expect(repository.readAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.operationNowMicros.mock.invocationCallOrder[0],
    );
    expect(
      repository.operationNowMicros.mock.invocationCallOrder[0],
    ).toBeLessThan(repository.writeAliases.mock.invocationCallOrder[0]);
    expect(repository.operationNowMicros).toHaveBeenCalledTimes(1);
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
    expect(repository.writeAliases).toHaveBeenCalledWith(
      transactions[0],
      [gate.key],
      gate.policyId,
      createGcraState(
        { numerator: 126000n, denominator: 1n },
        { burst: 1, rate: 8, periodSeconds: 1 },
      ),
    );
  });
  it.each([125999n, 126000n, 126001n])(
    'preserves exact microsecond eligibility at %s',
    async (now) => {
      const { service, repository } = setup(now);
      repository.readAliases.mockResolvedValue([row(126000n)]);
      const result = await service.tryAcquire();
      if (now < 126000n) {
        expect(result).toEqual({
          outcome: 'DEFERRED',
          operationNowMicros: now,
          retryNotBeforeMicros: 126000n,
        });
        expect(repository.writeAliases).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({
          outcome: 'GRANTED',
          operationNowMicros: now,
          nextPermissionNotBeforeMicros: now + 125000n,
        });
        expect(repository.writeAliases).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('does not accumulate eight permissions after idle time', async () => {
    const now = 1_000_000_000n,
      { service, repository } = setup(now);
    repository.readAliases
      .mockResolvedValueOnce([row(1n)])
      .mockResolvedValue([row(now + 125000n)]);
    expect((await service.tryAcquire()).outcome).toBe('GRANTED');
    expect(await service.tryAcquire()).toEqual({
      outcome: 'DEFERRED',
      operationNowMicros: now,
      retryNotBeforeMicros: now + 125000n,
    });
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
  });
  it('rounds only the reported boundary upward for a configured fractional interval', async () => {
    expect(await setup(1_000_000n, 3).service.tryAcquire()).toEqual({
      outcome: 'GRANTED',
      operationNowMicros: 1_000_000n,
      nextPermissionNotBeforeMicros: 1_333_334n,
    });
  });
  it.each([{ policyId: 'WRONG_POLICY' }, { burst: 2n }])(
    'fails closed on incompatible authoritative state (%p)',
    async (overrides) => {
      const { service, repository } = setup();
      repository.readAliases.mockResolvedValue([row(1001n, overrides)]);
      await expect(service.tryAcquire()).rejects.toMatchObject({
        reason: 'INVALID_STATE',
      });
      expect(repository.writeAliases).not.toHaveBeenCalled();
    },
  );
  it.each(['readAliases', 'writeAliases'] as const)(
    'sanitizes %s errors without granting or retrying',
    async (method) => {
      const { service, repository, prisma } = setup();
      repository[method].mockRejectedValue(new Error('Sensitive SQL details.'));
      await expect(service.tryAcquire()).rejects.toMatchObject({
        reason: 'STATE_UNAVAILABLE',
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );
  it('retries a confirmed abort only through a distinct whole-owner transaction', async () => {
    const { service, repository, prisma, transactions } = setup();
    repository.writeAliases.mockRejectedValueOnce(abort());
    expect((await service.tryAcquire()).outcome).toBe('GRANTED');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(transactions[0]).not.toBe(transactions[1]);
    expect(repository.operationNowMicros).toHaveBeenCalledTimes(2);
  });
  it('bounds confirmed-abort retries', async () => {
    const { service, repository, prisma } = setup();
    repository.writeAliases.mockRejectedValue(abort());
    await expect(service.tryAcquire()).rejects.toMatchObject({
      reason: 'RETRY_EXHAUSTED',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
  it('does not blindly retry or return a permission when commit acknowledgement is unknown', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async (work) => {
      await work({
        $executeRaw: jest.fn().mockResolvedValue(0),
      } as unknown as Prisma.TransactionClient);
      throw new Error('Private commit failure.');
    });
    await expect(service.tryAcquire()).rejects.toMatchObject({
      reason: 'COMMIT_OUTCOME_UNKNOWN',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('distinguishes pre-callback availability failure from uncertain commit', async () => {
    const { service, prisma, repository } = setup();
    prisma.$transaction.mockRejectedValueOnce(
      new Error('Private connection failure.'),
    );
    await expect(service.tryAcquire()).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
    });
    expect(repository.lockAliases).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
