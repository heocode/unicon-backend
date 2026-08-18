import { Prisma } from '../../generated/prisma/client';
import { isTransactionConflict } from './is-transaction-conflict.util';

describe('isTransactionConflict', () => {
  it('recognizes a standard Prisma transaction conflict', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Conflict.', {
      code: 'P2034',
      clientVersion: '7.8.0',
    });

    expect(isTransactionConflict(error)).toBe(true);
  });

  it('recognizes a raw-query adapter conflict wrapped as P2010', () => {
    const error = new Prisma.PrismaClientKnownRequestError('Conflict.', {
      code: 'P2010',
      clientVersion: '7.8.0',
      meta: {
        driverAdapterError: {
          cause: { kind: 'TransactionWriteConflict' },
        },
      },
    });

    expect(isTransactionConflict(error)).toBe(true);
  });

  it('recognizes a direct driver-adapter transaction conflict', () => {
    const error = new Error('Conflict.', {
      cause: { kind: 'TransactionWriteConflict' },
    });
    error.name = 'DriverAdapterError';

    expect(isTransactionConflict(error)).toBe(true);
  });

  it('rejects unrelated errors', () => {
    expect(isTransactionConflict(new Error('Database unavailable.'))).toBe(
      false,
    );
  });
});
