import { Prisma } from '../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';

/** Only DB-confirmed transaction aborts are safe to repeat without idempotency. */
export function isRetryableGcraTransactionError(error: unknown): boolean {
  // A composable call sanitizes confirmed aborts. Retry only after the owner
  // has rolled back its entire transaction, never inside the same callback.
  if (error instanceof GcraAdmissionInfrastructureError) {
    return error.reason === 'TRANSACTION_ABORTED';
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return true;
    }
    if (error.code === 'P2010') {
      if (isRollbackSqlState(error.meta?.code)) {
        return true;
      }
      return hasRollbackSqlState(error.meta?.driverAdapterError);
    }
    return false;
  }
  return hasRollbackSqlState(error);
}

function hasRollbackSqlState(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'DriverAdapterError') {
    return false;
  }
  const cause = error.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'originalCode' in cause &&
    isRollbackSqlState(cause.originalCode)
  );
}

function isRollbackSqlState(code: unknown): boolean {
  return code === '40001' || code === '40P01';
}
