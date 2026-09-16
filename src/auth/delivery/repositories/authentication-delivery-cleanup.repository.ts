// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type TransitionIdRow = { id: string };
type OperationTimestampRow = { operationNow: Date };

@Injectable()
export class AuthenticationDeliveryCleanupRepository {
  constructor(private readonly prisma: PrismaService) {}

  deleteOneRetainedTerminalBatch(batchSize: number): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<OperationTimestampRow[]>(
        Prisma.sql`SELECT clock_timestamp() AS "operationNow"`,
      );
      const operationNow = rows[0]?.operationNow;
      if (!operationNow) {
        throw new Error(
          'Authentication delivery cleanup timestamp is unavailable.',
        );
      }

      const deleted = await transaction.$queryRaw<TransitionIdRow[]>(Prisma.sql`
        WITH "candidates" AS (
          SELECT "id"
          FROM "AuthenticationChallengeDelivery"
          WHERE
            "status" IN ('SENT', 'FAILED', 'CANCELLED')
            AND "retentionExpiresAt" <= ${operationNow}
          ORDER BY "retentionExpiresAt" ASC, "createdAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        DELETE FROM "AuthenticationChallengeDelivery" AS "delivery"
        USING "candidates"
        WHERE "delivery"."id" = "candidates"."id"
        RETURNING "delivery"."id"
      `);

      return deleted.length;
    });
  }
}
