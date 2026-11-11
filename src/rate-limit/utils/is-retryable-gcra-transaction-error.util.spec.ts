import { Prisma } from '../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';

import { isRetryableGcraTransactionError } from './is-retryable-gcra-transaction-error.util';

function adapterError(code: string): Error {
  const error = new Error('Private database error.', {
    cause: { originalCode: code, kind: 'postgres' },
  });
  error.name = 'DriverAdapterError';
  return error;
}

describe('isRetryableGcraTransactionError', () => {
  it('recognizes the safe composable abort signal only for whole-owner-transaction retry', () => {
    expect(
      isRetryableGcraTransactionError(
        new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED'),
      ),
    ).toBe(true);
    expect(
      isRetryableGcraTransactionError(
        new GcraAdmissionInfrastructureError('COMMIT_OUTCOME_UNKNOWN'),
      ),
    ).toBe(false);
    expect(
      isRetryableGcraTransactionError(
        new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE'),
      ),
    ).toBe(false);
  });
  it('recognizes the explicit Prisma rollback conflict code', () => {
    expect(
      isRetryableGcraTransactionError(
        new Prisma.PrismaClientKnownRequestError('Conflict.', {
          code: 'P2034',
          clientVersion: '7.8.0',
        }),
      ),
    ).toBe(true);
  });

  it.each(['40001', '40P01'])(
    'recognizes confirmed PostgreSQL abort %s in every supported wrapper',
    (code) => {
      const error = adapterError(code);
      expect(isRetryableGcraTransactionError(error)).toBe(true);
      expect(
        isRetryableGcraTransactionError(
          new Prisma.PrismaClientKnownRequestError('Conflict.', {
            code: 'P2010',
            clientVersion: '7.8.0',
            meta: { driverAdapterError: error },
          }),
        ),
      ).toBe(true);
      expect(
        isRetryableGcraTransactionError(
          new Prisma.PrismaClientKnownRequestError('Conflict.', {
            code: 'P2010',
            clientVersion: '7.8.0',
            meta: { code },
          }),
        ),
      ).toBe(true);
    },
  );

  it.each(['23505', '23514', '55P03', '57014', '08006', 'ECONNRESET'])(
    'never retries unrelated/uncertain failure %s',
    (code) => {
      expect(isRetryableGcraTransactionError(adapterError(code))).toBe(false);
    },
  );

  it('does not infer rollback from text, an arbitrary cause or a generic conflict kind', () => {
    expect(
      isRetryableGcraTransactionError(new Error('40001 deadlock rollback')),
    ).toBe(false);
    expect(
      isRetryableGcraTransactionError({ cause: { originalCode: '40001' } }),
    ).toBe(false);
    const error = new Error('Conflict.', {
      cause: { kind: 'TransactionWriteConflict' },
    });
    error.name = 'DriverAdapterError';
    expect(isRetryableGcraTransactionError(error)).toBe(false);
    expect(
      isRetryableGcraTransactionError(
        new Prisma.PrismaClientKnownRequestError(
          'Unknown transaction result.',
          { code: 'P2028', clientVersion: '7.8.0' },
        ),
      ),
    ).toBe(false);
  });
});
