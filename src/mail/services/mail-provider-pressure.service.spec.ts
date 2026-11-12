import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { GcraAdmissionRepository } from '../../rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../../rate-limit/services/gcra-admission-config.service';
import { MailProviderPressureService } from './mail-provider-pressure.service';

function setup() {
  const repository = {
    read: jest.fn().mockImplementation(() =>
      Promise.resolve({
        id: 1,
        revision: 0n,
        retryNotBeforeMicros: 0n,
        dailyNotBeforeMicros: 0n,
        monthlyBlocked: false,
      }),
    ),
    write: jest.fn().mockResolvedValue(undefined),
  };
  const gcra = {
    lockAliases: jest.fn().mockResolvedValue(undefined),
    operationNowMicros: jest.fn().mockResolvedValue(1_000_000n),
  };
  const prisma = {
    $transaction: jest.fn(
      async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work({
          $executeRaw: jest.fn().mockResolvedValue(0),
        } as unknown as Prisma.TransactionClient),
    ),
  };
  const config = new ConfigService({
    MAIL_RESEND_RATE_LIMIT_FALLBACK_SECONDS: 1,
    RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
    RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 5,
    RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 2,
  });
  const service = new MailProviderPressureService(
    prisma as unknown as PrismaService,
    gcra as unknown as GcraAdmissionRepository,
    repository,
    new GcraAdmissionConfigService(config),
    config,
  );
  return { service, repository, gcra, prisma };
}
const observation = { statusCode: 429, headers: { 'retry-after': '30' } };
function abort() {
  return new Prisma.PrismaClientKnownRequestError('Private SQL detail', {
    code: 'P2034',
    clientVersion: 'test',
  });
}

describe('MailProviderPressureService transaction ownership', () => {
  it('skips unrelated responses without database writes', async () => {
    const { service, prisma } = setup();
    await service.observe({ statusCode: 200, headers: {} });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('samples time after lock/read and owns bounded ReadCommitted transactions', async () => {
    const { service, prisma, gcra, repository } = setup();
    await service.observe(observation);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 5000,
      maxWait: 2000,
    });
    expect(gcra.lockAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.read.mock.invocationCallOrder[0],
    );
    expect(repository.read.mock.invocationCallOrder[0]).toBeLessThan(
      gcra.operationNowMicros.mock.invocationCallOrder[0],
    );
    expect(repository.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ retryNotBeforeMicros: 31_000_000n }),
    );
  });
  it('retries confirmed aborts using a fresh time', async () => {
    const { service, repository, prisma, gcra } = setup();
    repository.write.mockRejectedValueOnce(abort());
    gcra.operationNowMicros
      .mockResolvedValueOnce(2_000_000n)
      .mockResolvedValueOnce(3_000_000n);
    await service.observe(observation);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(repository.write).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ retryNotBeforeMicros: 33_000_000n }),
    );
  });
  it('bounds confirmed abort retries', async () => {
    const { service, repository, prisma } = setup();
    repository.write.mockRejectedValue(abort());
    await expect(service.observe(observation)).rejects.toMatchObject({
      reason: 'RETRY_EXHAUSTED',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
  it('never blindly retries an unknown commit', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockImplementationOnce(async (work) => {
      await work({
        $executeRaw: jest.fn().mockResolvedValue(0),
      } as unknown as Prisma.TransactionClient);
      throw new Error('Private commit failure');
    });
    await expect(service.observe(observation)).rejects.toMatchObject({
      reason: 'COMMIT_OUTCOME_UNKNOWN',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
  it('sanitizes database errors without exposing the cause', async () => {
    const { service, repository } = setup();
    repository.read.mockRejectedValue(new Error('Private connection string'));
    await expect(service.observe(observation)).rejects.toMatchObject({
      reason: 'STATE_UNAVAILABLE',
      message: 'Authoritative GCRA admission could not be established.',
    });
  });
});
