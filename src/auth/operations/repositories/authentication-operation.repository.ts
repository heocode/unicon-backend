import { Injectable } from '@nestjs/common';

import {
  Prisma,
  type AuthenticationOperation,
} from '../../../generated/prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';
import { GcraAdmissionConfigService } from '../../../rate-limit/services/gcra-admission-config.service';

@Injectable()
export class AuthenticationOperationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bounds: GcraAdmissionConfigService,
  ) {}

  async nowMicros(tx: Prisma.TransactionClient = this.prisma): Promise<bigint> {
    const [row] = await tx.$queryRaw<{ now: string }[]>`
      SELECT trunc(EXTRACT(EPOCH FROM clock_timestamp())*1000000)::text AS now
    `;
    return BigInt(row.now);
  }

  async lock(tx: Prisma.TransactionClient, id: string): Promise<void> {
    // One operation lock, always before subject/entity/bucket locks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('unicon.auth.operation.lock.v1:' || ${id}, 0))`;
  }

  async read(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<AuthenticationOperation | null> {
    const rows = await tx.$queryRaw<AuthenticationOperation[]>`
      SELECT * FROM "AuthenticationOperation" WHERE "id"=${id}::uuid FOR UPDATE
    `;
    return rows[0] ?? null;
  }

  insert(
    tx: Prisma.TransactionClient,
    data: Prisma.AuthenticationOperationUncheckedCreateInput,
  ): Promise<AuthenticationOperation> {
    return tx.authenticationOperation.create({ data });
  }

  deleteRetainedBatch(batchSize: number): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${this.bounds.timeoutSeconds}s`}, true)`;
        const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        WITH candidates AS (
          SELECT "id" FROM "AuthenticationOperation"
          WHERE "retentionExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
          ORDER BY "retentionExpiresAt", "id" FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
        )
        DELETE FROM "AuthenticationOperation" AS receipt USING candidates
        WHERE receipt."id"=candidates."id" RETURNING receipt."id"
      `);
        return rows.length;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: this.bounds.timeoutSeconds * 1000,
        maxWait: this.bounds.maxWaitSeconds * 1000,
      },
    );
  }
}
