import { Prisma } from '../../generated/prisma/client';

export function isTransactionConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return true;
    }

    if (
      error.code === 'P2010' &&
      hasTransactionWriteConflict(error.meta?.driverAdapterError)
    ) {
      return true;
    }
  }

  return hasTransactionWriteConflict(error);
}

function hasTransactionWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('cause' in error)) {
    return false;
  }

  const cause = error.cause;

  return (
    typeof cause === 'object' &&
    cause !== null &&
    'kind' in cause &&
    cause.kind === 'TransactionWriteConflict'
  );
}
