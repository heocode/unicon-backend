import { Injectable } from '@nestjs/common';

import { Prisma, type GcraRateLimit } from '../../generated/prisma/client';

import type { GcraState } from '../types/gcra-state.type';
import { toGcraPersistenceData } from '../utils/gcra-state-persistence.util';

@Injectable()
export class GcraAdmissionRepository {
  async lockAliases(
    transaction: Prisma.TransactionClient,
    keys: readonly string[],
  ): Promise<void> {
    const ids = await transaction.$queryRaw<{ lockId: bigint }[]>(Prisma.sql`
      SELECT DISTINCT hashtextextended('unicon.rate-limit.lock.v1:' || "bucketKey", 0) AS "lockId"
      FROM (VALUES ${Prisma.join(keys.map((key) => Prisma.sql`(${key})`))}) AS buckets("bucketKey")
      ORDER BY "lockId"
    `);
    // Order the actual signed 64-bit lock IDs, not source keys or key versions.
    for (const { lockId } of ids) {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
    }
  }

  readAliases(
    transaction: Prisma.TransactionClient,
    keys: readonly string[],
  ): Promise<GcraRateLimit[]> {
    return transaction.$queryRaw<GcraRateLimit[]>(Prisma.sql`
      SELECT "key", "policyId", "tatNumerator", "tatDenominator", "idleAfterMicros",
        "burst", "rate", "periodSeconds", "updatedAt"
      FROM "GcraRateLimit"
      WHERE "key" IN (${Prisma.join(keys)})
      ORDER BY "key"
      FOR UPDATE
    `);
  }

  async operationNowMicros(
    transaction: Prisma.TransactionClient,
  ): Promise<bigint> {
    const [row] = await transaction.$queryRaw<{ operationNowMicros: string }[]>`
      SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::text AS "operationNowMicros"
    `;
    return BigInt(row.operationNowMicros);
  }

  async writeAliases(
    transaction: Prisma.TransactionClient,
    keys: readonly string[],
    policyId: string,
    state: GcraState,
  ): Promise<void> {
    const data = { policyId, ...toGcraPersistenceData(state) };
    for (const key of [...keys].sort()) {
      await transaction.gcraRateLimit.upsert({
        where: { key },
        create: { key, ...data },
        update: data,
      });
    }
  }
}
