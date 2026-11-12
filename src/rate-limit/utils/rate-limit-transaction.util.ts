import type { Prisma } from '../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';
import type { GcraAdmissionRepository } from '../repositories/gcra-admission.repository';
import { isRetryableGcraTransactionError } from './is-retryable-gcra-transaction-error.util';

const externalTransactions = new WeakSet<Prisma.TransactionClient>();

/** All participating rate policies must enter once, before acquiring bucket locks. */
export function reserveRateLimitTransaction(
  transaction: Prisma.TransactionClient,
): void {
  if (
    ('$connect' in transaction && transaction.$connect !== undefined) ||
    externalTransactions.has(transaction)
  ) {
    throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
  }
  externalTransactions.add(transaction);
}

/** No commit or retry here: the surrounding domain owns the transaction. */
export async function withRateLimitSavepoint<T>(
  transaction: Prisma.TransactionClient,
  repository: GcraAdmissionRepository,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const isolation = await repository.isolationLevel(transaction);
    if (isolation !== 'read committed' && isolation !== 'serializable')
      throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
    await transaction.$executeRaw`SAVEPOINT unicon_gcra_admission`;
  } catch (error) {
    throw externalFailure(error);
  }
  try {
    const result = await operation();
    await transaction.$executeRaw`RELEASE SAVEPOINT unicon_gcra_admission`;
    return result;
  } catch (error) {
    try {
      await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_gcra_admission`;
      await transaction.$executeRaw`RELEASE SAVEPOINT unicon_gcra_admission`;
    } catch {
      throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
    }
    throw externalFailure(error);
  }
}

function externalFailure(error: unknown): GcraAdmissionInfrastructureError {
  if (isRetryableGcraTransactionError(error))
    return new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED');
  return error instanceof GcraAdmissionInfrastructureError
    ? error
    : new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
}
