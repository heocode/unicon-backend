// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type TransitionIdRow = {
  id: string;
};

type OperationTimestampRow = {
  operationNow: Date;
};

@Injectable()
export class AuthenticationChallengeCleanupRepository {
  constructor(private readonly prisma: PrismaService) {}

  clearOneExpiredEnvelopeBatch(batchSize: number): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const rows = await transaction.$queryRaw<TransitionIdRow[]>(Prisma.sql`
        WITH "candidates" AS (
          SELECT "id"
          FROM "AuthenticationChallenge"
          WHERE
            "expiresAt" <= ${operationNow}
            AND "encryptedProof" IS NOT NULL
          ORDER BY "expiresAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        UPDATE "AuthenticationChallenge" AS "challenge"
        SET
          "encryptedProof" = NULL,
          "proofEncryptionIv" = NULL,
          "proofEncryptionTag" = NULL,
          "updatedAt" = ${operationNow}
        FROM "candidates"
        WHERE "challenge"."id" = "candidates"."id"
        RETURNING "challenge"."id"
      `);

      return rows.length;
    });
  }

  deleteOneRetainedChallengeBatch(batchSize: number): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const rows = await transaction.$queryRaw<TransitionIdRow[]>(Prisma.sql`
        WITH "candidates" AS (
          SELECT "id"
          FROM "AuthenticationChallenge"
          WHERE "retentionExpiresAt" <= ${operationNow}
          ORDER BY "retentionExpiresAt" ASC, "id" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${batchSize}
        )
        DELETE FROM "AuthenticationChallenge" AS "challenge"
        USING "candidates"
        WHERE "challenge"."id" = "candidates"."id"
        RETURNING "challenge"."id"
      `);

      return rows.length;
    });
  }

  deleteOneOrphanedSubjectBatch(batchSize: number): Promise<number> {
    return this.prisma.$transaction(
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          { key: string }[]
        >(Prisma.sql`
        SELECT subject."key" FROM "AuthenticationChallengeSubject" AS subject
        WHERE subject."normalizedIdentity" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "AuthenticationChallenge" AS challenge
          WHERE challenge."subjectKey"=subject."key" OR (
            challenge."normalizedIdentity"=subject."normalizedIdentity"
            AND challenge."purpose"=subject."purpose"
          )
        )
        ORDER BY subject."key" FOR UPDATE OF subject SKIP LOCKED LIMIT ${batchSize}
      `);
        if (!candidates.length) return 0;
        // A separate RC statement sees children committed before the subject lock.
        // The held parent FOR UPDATE locks prevent subsequent FK insertions.
        const deleted = await transaction.$queryRaw<
          { key: string }[]
        >(Prisma.sql`
        DELETE FROM "AuthenticationChallengeSubject" AS subject
        WHERE subject."key" IN (${Prisma.join(candidates.map((row) => row.key))})
          AND subject."normalizedIdentity" IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM "AuthenticationChallenge" AS challenge
            WHERE challenge."subjectKey"=subject."key" OR (
              challenge."normalizedIdentity"=subject."normalizedIdentity"
              AND challenge."purpose"=subject."purpose"
            )
          )
        RETURNING subject."key"
      `);
        return deleted.length;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private async getOperationTimestamp(
    transaction: Prisma.TransactionClient,
  ): Promise<Date> {
    const rows = await transaction.$queryRaw<OperationTimestampRow[]>(
      Prisma.sql`SELECT clock_timestamp() AS "operationNow"`,
    );
    const operationNow = rows[0]?.operationNow;

    if (!operationNow) {
      throw new Error(
        'Authentication challenge cleanup timestamp is unavailable.',
      );
    }

    return operationNow;
  }
}
