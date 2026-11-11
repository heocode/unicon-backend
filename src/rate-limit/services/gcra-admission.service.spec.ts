import { ConfigService } from '@nestjs/config';

import { Prisma, type GcraRateLimit } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY as policy } from '../../http-rate-limit/constants/http-request-rate-limit-policies.constants';
import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';
import type { GcraAdmissionResult } from '../types/gcra-admission.type';
import { createGcraState } from '../utils/gcra-state.util';
import { toGcraPersistenceData } from '../utils/gcra-state-persistence.util';
import { GcraAdmissionConfigService } from './gcra-admission-config.service';
import { GcraAdmissionService } from './gcra-admission.service';
import { RateLimitBucketKeyService } from './rate-limit-bucket-key.service';

const settings = { burst: 1, rate: 1, periodSeconds: 3600 };
const input = { policy, settings, characteristic: '192.0.2.1' };

function setup() {
  const config = new ConfigService({
    RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 2,
    RATE_LIMIT_HMAC_KEYS: new Map([
      [1, Buffer.alloc(32, 4)],
      [2, Buffer.alloc(32, 5)],
    ]),
    RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
    RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 5,
    RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 2,
  });
  const derivation = new RateLimitBucketKeyService(config);
  const transaction = {
    $executeRaw: jest.fn(() => Promise.resolve(0)),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    $transaction: jest.fn(
      async (
        callback: (
          tx: Prisma.TransactionClient,
        ) => Promise<GcraAdmissionResult>,
      ) => callback(transaction),
    ),
  };
  const repository = {
    isolationLevel: jest.fn(() => Promise.resolve('read committed')),
    lockAliases: jest.fn(async (): Promise<void> => {}),
    readAliases: jest.fn(() => Promise.resolve<GcraRateLimit[]>([])),
    operationNowMicros: jest.fn(() => Promise.resolve(1_000_000n)),
    writeAliases: jest.fn(async (): Promise<void> => {}),
  };
  const service = new GcraAdmissionService(
    prisma as unknown as PrismaService,
    derivation,
    repository,
    new GcraAdmissionConfigService(config),
  );
  return { service, prisma, repository, derivation, transaction };
}

function storedRow(key: string, overrides = {}): GcraRateLimit {
  const data = toGcraPersistenceData(
    createGcraState({ numerator: 3_601_000_000n, denominator: 1n }, settings),
  );
  return {
    ...data,
    tatNumerator: new Prisma.Decimal(data.tatNumerator),
    tatDenominator: new Prisma.Decimal(data.tatDenominator),
    idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
    key,
    policyId: policy.id,
    updatedAt: new Date(0),
    ...overrides,
  };
}

describe('GcraAdmissionService control flow (unit)', () => {
  const second = {
    ...input,
    policy: { id: 'TEST_GCRA_SECOND', characteristicKind: 'IP' as const },
  };

  it('locks the full union and uses one DB timestamp for all policy charges', async () => {
    const { service, repository, derivation } = setup();
    expect(await service.consumeMany([second, input])).toEqual({
      allowed: true,
      operationNowMicros: 1_000_000n,
    });
    const allKeys = [input, second].flatMap((item) =>
      derivation
        .deriveKeys(item.policy, item.characteristic)
        .buckets.map((bucket) => bucket.key),
    );
    expect(repository.lockAliases).toHaveBeenCalledTimes(1);
    expect(repository.lockAliases).toHaveBeenCalledWith(
      expect.anything(),
      allKeys,
    );
    expect(repository.operationNowMicros).toHaveBeenCalledTimes(1);
    expect(repository.writeAliases).toHaveBeenCalledTimes(2);
  });

  it('attributes all denials and combines retry-after without any writes', async () => {
    const { service, repository, derivation } = setup();
    const firstKey = derivation.deriveKeys(input.policy, input.characteristic)
      .buckets[0].key;
    const secondKey = derivation.deriveKeys(
      second.policy,
      second.characteristic,
    ).buckets[0].key;
    repository.readAliases.mockResolvedValue([
      storedRow(firstKey),
      storedRow(secondKey, {
        policyId: second.policy.id,
        tatNumerator: new Prisma.Decimal('7201000000'),
        idleAfterMicros: new Prisma.Decimal('7201000000'),
      }),
    ]);
    expect(await service.consumeMany([second, input])).toEqual({
      allowed: false,
      operationNowMicros: 1_000_000n,
      retryAfterSeconds: 7200n,
      deniedPolicyIds: [input.policy.id, second.policy.id],
    });
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it('does not mask a later invalid policy as an earlier ordinary denial', async () => {
    const { service, repository, derivation } = setup();
    const firstKey = derivation.deriveKeys(input.policy, input.characteristic)
      .buckets[0].key;
    const secondKey = derivation.deriveKeys(
      second.policy,
      second.characteristic,
    ).buckets[0].key;
    repository.readAliases.mockResolvedValue([
      storedRow(firstKey),
      storedRow(secondKey, { policyId: second.policy.id, burst: 2n }),
    ]);
    await expect(service.consumeMany([input, second])).rejects.toMatchObject({
      reason: 'INVALID_STATE',
    });
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'empty', inputs: [] },
    { label: 'duplicate', inputs: [input, input] },
    {
      label: 'duplicate policy with another subject',
      inputs: [input, { ...input, characteristic: '192.0.2.2' }],
    },
  ])('rejects $label sets before opening a transaction', async ({ inputs }) => {
    const { service, prisma } = setup();
    await expect(service.consumeMany(inputs)).rejects.toMatchObject({
      reason: 'INVALID_INPUT',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not create an owned transaction inside the composable method', async () => {
    const { service, prisma, transaction } = setup();
    expect(
      (await service.consumeManyInTransaction(transaction, [input, second]))
        .allowed,
    ).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(
      service.consumeManyInTransaction(transaction, [input]),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
  });

  it('checks isolation before taking any bucket locks', async () => {
    const { service, transaction, repository } = setup();
    repository.isolationLevel.mockResolvedValue('repeatable read');
    await expect(
      service.consumeManyInTransaction(transaction, [input]),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(repository.lockAliases).not.toHaveBeenCalled();
  });

  it('rolls the operation back to its savepoint on write failure without retrying', async () => {
    const { service, transaction, repository, prisma } = setup();
    repository.writeAliases.mockRejectedValue(
      new Error('private write failure'),
    );
    await expect(
      service.consumeManyInTransaction(transaction, [input, second]),
    ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(transaction.$executeRaw).toHaveBeenCalledWith(
      expect.arrayContaining(['ROLLBACK TO SAVEPOINT unicon_gcra_admission']),
    );
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports a sanitized confirmed abort to the external owner without retrying it', async () => {
    const { service, transaction, repository } = setup();
    repository.writeAliases.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Conflict.', {
        code: 'P2034',
        clientVersion: '7.8.0',
      }),
    );
    await expect(
      service.consumeManyInTransaction(transaction, [input]),
    ).rejects.toMatchObject({ reason: 'TRANSACTION_ABORTED' });
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
  });

  it('returns admission only after transaction resolution and writes all retained aliases', async () => {
    const { service, prisma, repository, derivation } = setup();
    expect(await service.consume(input)).toEqual({
      allowed: true,
      operationNowMicros: 1_000_000n,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      timeout: 5000,
      maxWait: 2000,
    });
    expect(repository.writeAliases).toHaveBeenCalledWith(
      expect.anything(),
      derivation
        .deriveKeys(policy, input.characteristic)
        .buckets.map((bucket) => bucket.key),
      policy.id,
      expect.objectContaining({ policy: settings }),
    );
    expect(repository.lockAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.readAliases.mock.invocationCallOrder[0],
    );
    expect(repository.readAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.operationNowMicros.mock.invocationCallOrder[0],
    );
  });

  it('returns denial without writes or repairing a missing alias', async () => {
    const { service, repository, derivation } = setup();
    const key = derivation.deriveKeys(policy, input.characteristic).buckets[0]
      .key;
    repository.readAliases.mockResolvedValue([storedRow(key)]);
    expect(await service.consume(input)).toEqual({
      allowed: false,
      operationNowMicros: 1_000_000n,
      retryAfterSeconds: 3600n,
    });
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it.each([{ policyId: 'OTHER_POLICY' }, { burst: 2n }])(
    'fails closed on state mismatch %p without writes',
    async (overrides) => {
      const { service, repository, derivation } = setup();
      const key = derivation.deriveKeys(policy, input.characteristic).buckets[0]
        .key;
      repository.readAliases.mockResolvedValue([storedRow(key, overrides)]);
      await expect(service.consume(input)).rejects.toMatchObject({
        reason: 'INVALID_STATE',
      });
      expect(repository.writeAliases).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid input before creating a transaction', async () => {
    const { service, prisma } = setup();
    await expect(
      service.consume({ ...input, characteristic: undefined }),
    ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retries confirmed rollbacks within the bound', async () => {
    const { service, prisma, repository } = setup();
    const conflict = new Prisma.PrismaClientKnownRequestError('Conflict.', {
      code: 'P2034',
      clientVersion: '7.8.0',
    });
    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict);
    expect((await service.consume(input)).allowed).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries as a technical failure, not a fabricated denial', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Conflict.', {
        code: 'P2034',
        clientVersion: '7.8.0',
      }),
    );
    await expect(service.consume(input)).rejects.toMatchObject({
      reason: 'RETRY_EXHAUSTED',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry a lost commit acknowledgement after the callback completed', async () => {
    const { service, prisma, repository } = setup();
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      await callback({
        $executeRaw: jest.fn(() => Promise.resolve(0)),
      } as unknown as Prisma.TransactionClient);
      throw new Error('Private lost acknowledgement.');
    });
    await expect(service.consume(input)).rejects.toMatchObject({
      reason: 'COMMIT_OUTCOME_UNKNOWN',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(repository.writeAliases).toHaveBeenCalledTimes(1);
  });

  it('does not retry unavailability or retain its raw diagnostics', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(
      new Error('private query and connection details'),
    );
    const error: unknown = await service
      .consume(input)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(GcraAdmissionInfrastructureError);
    expect(error).toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(String(error)).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
