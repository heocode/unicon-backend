import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';

@Injectable()
export class AuthenticationDeliveryBacklogRepository {
  /** Caller owns the admission savepoint, entity locks, isolation and commit.
   * All new-Delivery admissions must update this row before counting/inserting.
   * Updating rather than only locking it forces stale Serializable owners to abort,
   * including when the preceding admission used ReadCommitted. No counter is stored. */
  async lockAndCountInTransaction(
    transaction: Prisma.TransactionClient,
  ): Promise<{
    outstanding: bigint;
    operationNowMicros: bigint;
  }> {
    const locked = await transaction.$queryRaw<{ id: number }[]>`
      UPDATE "AuthenticationDeliveryBacklogState"
      SET "updatedAt"=clock_timestamp() WHERE "id"=1 RETURNING "id"
    `;
    if (locked.length !== 1)
      throw new GcraAdmissionInfrastructureError('INVALID_STATE');
    // A separate statement sees the previous lock owner's commit at ReadCommitted.
    // Terminal transitions/recovery never acquire this coordination row, so they
    // can progress at capacity; PENDING/PROCESSING transitions do not release a slot.
    const [row] = await transaction.$queryRaw<
      { outstanding: string; now: string }[]
    >`
      SELECT count(*)::text AS outstanding,
        trunc(EXTRACT(EPOCH FROM clock_timestamp())*1000000)::text AS now
      FROM "AuthenticationChallengeDelivery"
      WHERE "status" IN ('PENDING','PROCESSING')
    `;
    return {
      outstanding: BigInt(row.outstanding),
      operationNowMicros: BigInt(row.now),
    };
  }
}
