// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import { Prisma } from '../../../generated/prisma/client';
import type { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

// Internal errors
import { AuthenticationChallengeTransitionConflictError } from '../errors/authentication-challenge-transition-conflict.error';

export type LockedAuthenticationChallenge = {
  id: string;
  normalizedIdentity: string;
  purpose: AuthenticationChallengePurpose;
  userId: string | null;
  boundSessionId: string | null;
  otpHash: Uint8Array;
  linkTokenHash: Uint8Array;
  hashProtocolVersion: number;
  hashKeyVersion: number;
  expiresAt: Date;
  failedAttemptCount: number;
  consumedAt: Date | null;
  lockedAt: Date | null;
};

export type ProofFailureTransition = {
  failedAttemptCount: number;
  lockedAt: Date | null;
};

type OperationTimestampRow = {
  operationNow: Date;
};

type TransitionIdRow = {
  id: string;
};

@Injectable()
export class AuthenticationChallengeRepository {
  async lockByIdForUpdate(
    transaction: Prisma.TransactionClient,
    challengeId: string,
  ): Promise<LockedAuthenticationChallenge | null> {
    const challenges = await transaction.$queryRaw<
      LockedAuthenticationChallenge[]
    >(Prisma.sql`
      SELECT
        "id",
        "normalizedIdentity",
        "purpose",
        "userId",
        "boundSessionId",
        "otpHash",
        "linkTokenHash",
        "hashProtocolVersion",
        "hashKeyVersion",
        "expiresAt",
        "failedAttemptCount",
        "consumedAt",
        "lockedAt"
      FROM "AuthenticationChallenge"
      WHERE "id" = ${challengeId}
      FOR UPDATE
    `);

    return challenges[0] ?? null;
  }

  async getOperationTimestamp(
    transaction: Prisma.TransactionClient,
  ): Promise<Date> {
    const rows = await transaction.$queryRaw<OperationTimestampRow[]>(
      Prisma.sql`SELECT clock_timestamp() AS "operationNow"`,
    );
    const operationNow = rows[0]?.operationNow;

    if (!operationNow) {
      throw new AuthenticationChallengeTransitionConflictError();
    }

    return operationNow;
  }

  async clearExpiredEnvelope(
    transaction: Prisma.TransactionClient,
    challengeId: string,
    operationNow: Date,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<TransitionIdRow[]>(Prisma.sql`
      UPDATE "AuthenticationChallenge"
      SET
        "encryptedProof" = NULL,
        "proofEncryptionIv" = NULL,
        "proofEncryptionTag" = NULL,
        "updatedAt" = ${operationNow}
      WHERE
        "id" = ${challengeId}
        AND "consumedAt" IS NULL
        AND "lockedAt" IS NULL
        AND "expiresAt" <= ${operationNow}
      RETURNING "id"
    `);

    this.assertSingleTransition(rows);
  }

  async recordProofFailure(
    transaction: Prisma.TransactionClient,
    challengeId: string,
    operationNow: Date,
  ): Promise<ProofFailureTransition> {
    const rows = await transaction.$queryRaw<
      ProofFailureTransition[]
    >(Prisma.sql`
      UPDATE "AuthenticationChallenge"
      SET
        "failedAttemptCount" = "failedAttemptCount" + 1,
        "updatedAt" = ${operationNow}
      WHERE
        "id" = ${challengeId}
        AND "consumedAt" IS NULL
        AND "lockedAt" IS NULL
        AND "expiresAt" > ${operationNow}
      RETURNING "failedAttemptCount", "lockedAt"
    `);

    if (rows.length !== 1) {
      throw new AuthenticationChallengeTransitionConflictError();
    }

    return rows[0];
  }

  async consume(
    transaction: Prisma.TransactionClient,
    challengeId: string,
    operationNow: Date,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<TransitionIdRow[]>(Prisma.sql`
      UPDATE "AuthenticationChallenge"
      SET
        "consumedAt" = ${operationNow},
        "encryptedProof" = NULL,
        "proofEncryptionIv" = NULL,
        "proofEncryptionTag" = NULL,
        "updatedAt" = ${operationNow}
      WHERE
        "id" = ${challengeId}
        AND "consumedAt" IS NULL
        AND "lockedAt" IS NULL
        AND "expiresAt" > ${operationNow}
      RETURNING "id"
    `);

    this.assertSingleTransition(rows);
  }

  private assertSingleTransition(rows: TransitionIdRow[]): void {
    if (rows.length !== 1) {
      throw new AuthenticationChallengeTransitionConflictError();
    }
  }
}
