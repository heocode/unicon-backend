import { randomUUID } from 'crypto';

// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import { Prisma } from '../../../generated/prisma/client';
import {
  AuthenticationChallengePurpose,
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
  AuthenticationDeliveryStatus,
} from '../../../generated/prisma/enums';
import { PrismaService } from '../../../prisma/prisma.service';

// Internal services
import { AuthenticationDeliveryPolicyService } from '../services/authentication-delivery-policy.service';

// Internal types
import {
  AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
  AUTHENTICATION_DELIVERY_INTERNAL_INVARIANT_FAILURE,
  AuthenticationDeliveryCancellationReason,
  AuthenticationDeliveryClaimKind,
  AuthenticationDeliveryTransitionOutcome,
  type ClaimedAuthenticationDelivery,
  type CreatedAuthenticationDelivery,
  type CreateInitialAuthenticationDeliveryInput,
  type CreateResendAuthenticationDeliveryInput,
  type CreateResendAuthenticationDeliveryResult,
  type OwnedAuthenticationDeliveryChallengeResult,
} from '../types/authentication-delivery.type';

type OperationTimestampRow = {
  operationNow: Date;
};

type ResendChallengeRow = {
  id: string;
  normalizedIdentity: string;
  expiresAt: Date;
  failedAttemptCount: number;
  maxAttempts: number;
  consumedAt: Date | null;
  lockedAt: Date | null;
  encryptedProof: Uint8Array | null;
  proofEncryptionIv: Uint8Array | null;
  proofEncryptionTag: Uint8Array | null;
};

type ClaimedDeliveryRow = Omit<
  ClaimedAuthenticationDelivery,
  'leaseId' | 'leaseExpiresAt' | 'claimKind'
> & {
  processingLeaseId: string;
  processingLeaseExpiresAt: Date;
  claimKind: AuthenticationDeliveryClaimKind;
};

type OwnedDeliveryChallengeRow = {
  operationNow: Date;
  id: string;
  normalizedIdentity: string;
  purpose: AuthenticationChallengePurpose;
  expiresAt: Date;
  failedAttemptCount: number;
  maxAttempts: number;
  consumedAt: Date | null;
  lockedAt: Date | null;
  encryptedProof: Uint8Array | null;
  proofEncryptionIv: Uint8Array | null;
  proofEncryptionTag: Uint8Array | null;
  encryptionProtocolVersion: number;
  encryptionKeyVersion: number;
};

@Injectable()
export class AuthenticationDeliveryRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AuthenticationDeliveryPolicyService,
  ) {}

  async createInitialDelivery(
    transaction: Prisma.TransactionClient,
    input: CreateInitialAuthenticationDeliveryInput,
  ): Promise<CreatedAuthenticationDelivery> {
    return this.createDelivery(
      transaction,
      input,
      AuthenticationDeliveryOrigin.INITIAL,
    );
  }

  createResendDelivery(
    input: CreateResendAuthenticationDeliveryInput,
  ): Promise<CreateResendAuthenticationDeliveryResult> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const challenge = await this.lockChallengeForResend(
        transaction,
        input.challengeId,
      );

      if (!this.isChallengeAvailableForResend(challenge, operationNow)) {
        return { outcome: 'CHALLENGE_UNAVAILABLE' };
      }

      const superseded =
        await transaction.authenticationChallengeDelivery.updateMany({
          where: {
            challengeId: input.challengeId,
            status: {
              in: [
                AuthenticationDeliveryStatus.PENDING,
                AuthenticationDeliveryStatus.PROCESSING,
              ],
            },
          },
          data: {
            status: AuthenticationDeliveryStatus.CANCELLED,
            lastSafeFailureCode:
              AuthenticationDeliveryCancellationReason.SUPERSEDED_BY_RESEND,
            nextAttemptAt: null,
            processingLeaseId: null,
            processingLeaseExpiresAt: null,
            updatedAt: operationNow,
          },
        });
      const delivery = await this.createDelivery(
        transaction,
        {
          ...input,
          recipientSnapshot: challenge.normalizedIdentity,
        },
        AuthenticationDeliveryOrigin.RESEND,
      );

      return {
        outcome: 'CREATED',
        delivery,
        supersededDeliveryCount: superseded.count,
      };
    });
  }

  claimNextDelivery(): Promise<ClaimedAuthenticationDelivery | null> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(
        operationNow.getTime() + this.policy.processingLeaseSeconds * 1_000,
      );
      const rows = await transaction.$queryRaw<ClaimedDeliveryRow[]>(Prisma.sql`
        WITH "candidate" AS (
          SELECT
            "delivery"."id",
            "delivery"."status" AS "previousStatus",
            CASE
              WHEN "delivery"."status" = 'PROCESSING'
                THEN "delivery"."processingLeaseExpiresAt"
              ELSE COALESCE(
                "delivery"."nextAttemptAt",
                "delivery"."createdAt"
              )
            END AS "eligibleAt"
          FROM "AuthenticationChallengeDelivery" AS "delivery"
          INNER JOIN "AuthenticationChallenge" AS "challenge"
            ON "challenge"."id" = "delivery"."challengeId"
          WHERE
            (
              (
                "delivery"."status" = 'PENDING'
                AND (
                  "delivery"."nextAttemptAt" IS NULL
                  OR "delivery"."nextAttemptAt" <= ${operationNow}
                )
              )
              OR
              (
                "delivery"."status" = 'PROCESSING'
                AND "delivery"."processingLeaseExpiresAt" <= ${operationNow}
              )
            )
            AND "delivery"."attemptCount" < ${this.policy.maxProcessingAttempts}
          ORDER BY
            "eligibleAt" ASC,
            "delivery"."createdAt" ASC,
            "delivery"."id" ASC
          FOR UPDATE OF "delivery" SKIP LOCKED
          LIMIT 1
        )
        UPDATE "AuthenticationChallengeDelivery" AS "delivery"
        SET
          "status" = 'PROCESSING',
          "attemptCount" = "delivery"."attemptCount" + 1,
          "nextAttemptAt" = NULL,
          "processingLeaseId" = ${leaseId}::uuid,
          "processingLeaseExpiresAt" = ${leaseExpiresAt},
          "attemptedAt" = ${operationNow},
          "updatedAt" = ${operationNow}
        FROM "candidate"
        WHERE "delivery"."id" = "candidate"."id"
        RETURNING
          "delivery"."id",
          "delivery"."challengeId",
          "delivery"."method",
          "delivery"."origin",
          "delivery"."recipientSnapshot",
          "delivery"."idempotencyKey",
          "delivery"."templateProtocolVersion",
          "delivery"."attemptCount",
          "delivery"."processingLeaseId",
          "delivery"."processingLeaseExpiresAt",
          CASE
            WHEN "candidate"."previousStatus" = 'PROCESSING'
              THEN 'EXPIRED_LEASE_RECLAIM'
            ELSE 'NORMAL'
          END AS "claimKind"
      `);
      const claimed = rows[0];

      if (!claimed) {
        return null;
      }

      return {
        id: claimed.id,
        challengeId: claimed.challengeId,
        method: claimed.method,
        origin: claimed.origin,
        recipientSnapshot: claimed.recipientSnapshot,
        idempotencyKey: claimed.idempotencyKey,
        templateProtocolVersion: claimed.templateProtocolVersion,
        attemptCount: claimed.attemptCount,
        leaseId: claimed.processingLeaseId,
        leaseExpiresAt: claimed.processingLeaseExpiresAt,
        claimKind: claimed.claimKind,
      };
    });
  }

  async getOwnedChallengeState(
    deliveryId: string,
    leaseId: string,
    challengeId: string,
  ): Promise<OwnedAuthenticationDeliveryChallengeResult> {
    const rows = await this.prisma.$queryRaw<OwnedDeliveryChallengeRow[]>(
      Prisma.sql`
        SELECT
          clock_timestamp() AS "operationNow",
          "challenge"."id",
          "challenge"."normalizedIdentity",
          "challenge"."purpose",
          "challenge"."expiresAt",
          "challenge"."failedAttemptCount",
          "challenge"."maxAttempts",
          "challenge"."consumedAt",
          "challenge"."lockedAt",
          "challenge"."encryptedProof",
          "challenge"."proofEncryptionIv",
          "challenge"."proofEncryptionTag",
          "challenge"."encryptionProtocolVersion",
          "challenge"."encryptionKeyVersion"
        FROM "AuthenticationChallengeDelivery" AS "delivery"
        INNER JOIN "AuthenticationChallenge" AS "challenge"
          ON "challenge"."id" = "delivery"."challengeId"
        WHERE
          "delivery"."id" = ${deliveryId}
          AND "delivery"."challengeId" = ${challengeId}
          AND "delivery"."status" = 'PROCESSING'
          AND "delivery"."processingLeaseId" = ${leaseId}::uuid
          AND "delivery"."processingLeaseExpiresAt" > clock_timestamp()
      `,
    );
    const row = rows[0];

    if (!row) {
      return { outcome: 'LEASE_LOST' };
    }

    return {
      outcome: 'AVAILABLE',
      operationNow: row.operationNow,
      challenge: {
        id: row.id,
        normalizedIdentity: row.normalizedIdentity,
        purpose: row.purpose,
        expiresAt: row.expiresAt,
        failedAttemptCount: row.failedAttemptCount,
        maxAttempts: row.maxAttempts,
        consumedAt: row.consumedAt,
        lockedAt: row.lockedAt,
        encryptedProof: row.encryptedProof,
        proofEncryptionIv: row.proofEncryptionIv,
        proofEncryptionTag: row.proofEncryptionTag,
        encryptionProtocolVersion: row.encryptionProtocolVersion,
        encryptionKeyVersion: row.encryptionKeyVersion,
      },
    };
  }

  async getOwnedOperationTimestamp(
    deliveryId: string,
    leaseId: string,
  ): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<
      OperationTimestampRow[]
    >(Prisma.sql`
      SELECT clock_timestamp() AS "operationNow"
      FROM "AuthenticationChallengeDelivery"
      WHERE
        "id" = ${deliveryId}
        AND "status" = 'PROCESSING'
        AND "processingLeaseId" = ${leaseId}::uuid
        AND "processingLeaseExpiresAt" > clock_timestamp()
    `);

    return rows[0]?.operationNow ?? null;
  }

  terminalizeExpiredExhaustedLeases(batchSize: number): Promise<number> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const rows = await transaction.$queryRaw<{ id: string }[]>(Prisma.sql`
        WITH "candidates" AS (
          SELECT "delivery"."id", CASE
            WHEN "challenge"."consumedAt" IS NOT NULL
              OR "challenge"."lockedAt" IS NOT NULL
              OR "challenge"."expiresAt" <= ${operationNow}
              OR "challenge"."failedAttemptCount" >= "challenge"."maxAttempts"
              THEN true
            ELSE false
          END AS "challengeUnavailable"
          FROM "AuthenticationChallengeDelivery" AS "delivery"
          INNER JOIN "AuthenticationChallenge" AS "challenge"
            ON "challenge"."id" = "delivery"."challengeId"
          WHERE
            (
              "delivery"."status" = 'PENDING'
              OR (
                "delivery"."status" = 'PROCESSING'
                AND "delivery"."processingLeaseExpiresAt" <= ${operationNow}
              )
            )
            AND "delivery"."attemptCount" >= ${this.policy.maxProcessingAttempts}
          ORDER BY "delivery"."createdAt" ASC, "delivery"."id" ASC
          FOR UPDATE OF "delivery" SKIP LOCKED
          LIMIT ${batchSize}
        )
        UPDATE "AuthenticationChallengeDelivery" AS "delivery"
        SET
          "status" = CASE
            WHEN "candidates"."challengeUnavailable"
              THEN 'CANCELLED'::"AuthenticationDeliveryStatus"
            ELSE 'FAILED'::"AuthenticationDeliveryStatus"
          END,
          "lastSafeFailureCode" = CASE
            WHEN "candidates"."challengeUnavailable"
              THEN ${AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE}
            ELSE ${AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED}
          END,
          "nextAttemptAt" = NULL,
          "processingLeaseId" = NULL,
          "processingLeaseExpiresAt" = NULL,
          "updatedAt" = ${operationNow}
        FROM "candidates"
        WHERE "delivery"."id" = "candidates"."id"
        RETURNING "delivery"."id"
      `);

      return rows.length;
    });
  }

  markSent(
    deliveryId: string,
    leaseId: string,
    providerMessageId?: string,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.applyOwnedTransition(deliveryId, leaseId, (operationNow) => ({
      status: AuthenticationDeliveryStatus.SENT,
      providerMessageId: providerMessageId ?? null,
      sentAt: operationNow,
      lastSafeFailureCode: null,
      nextAttemptAt: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      updatedAt: operationNow,
    }));
  }

  scheduleRetry(
    deliveryId: string,
    leaseId: string,
    nextAttemptAt: Date,
    safeFailureCode: string,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.applyOwnedTransition(deliveryId, leaseId, (operationNow) => ({
      status: AuthenticationDeliveryStatus.PENDING,
      nextAttemptAt,
      lastSafeFailureCode: safeFailureCode,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      updatedAt: operationNow,
    }));
  }

  scheduleRetryAfter(
    deliveryId: string,
    leaseId: string,
    delaySeconds: number,
    safeFailureCode: string,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    if (!Number.isFinite(delaySeconds) || delaySeconds < 0) {
      throw new Error('Authentication delivery retry delay is invalid.');
    }

    return this.applyOwnedTransition(deliveryId, leaseId, (operationNow) => ({
      status: AuthenticationDeliveryStatus.PENDING,
      nextAttemptAt: new Date(operationNow.getTime() + delaySeconds * 1_000),
      lastSafeFailureCode: safeFailureCode,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      updatedAt: operationNow,
    }));
  }

  markFailed(
    deliveryId: string,
    leaseId: string,
    safeFailureCode: string,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.applyOwnedTransition(deliveryId, leaseId, (operationNow) => ({
      status: AuthenticationDeliveryStatus.FAILED,
      lastSafeFailureCode: safeFailureCode,
      nextAttemptAt: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      updatedAt: operationNow,
    }));
  }

  markInternalFailure(
    deliveryId: string,
    leaseId: string,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.markFailed(
      deliveryId,
      leaseId,
      AUTHENTICATION_DELIVERY_INTERNAL_INVARIANT_FAILURE,
    );
  }

  cancelOwnedDelivery(
    deliveryId: string,
    leaseId: string,
    safeReason: AuthenticationDeliveryCancellationReason,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.applyOwnedTransition(deliveryId, leaseId, (operationNow) => ({
      status: AuthenticationDeliveryStatus.CANCELLED,
      lastSafeFailureCode: safeReason,
      nextAttemptAt: null,
      processingLeaseId: null,
      processingLeaseExpiresAt: null,
      updatedAt: operationNow,
    }));
  }

  private async createDelivery(
    transaction: Prisma.TransactionClient,
    input: CreateInitialAuthenticationDeliveryInput,
    origin: AuthenticationDeliveryOrigin,
  ): Promise<CreatedAuthenticationDelivery> {
    return transaction.authenticationChallengeDelivery.create({
      data: {
        challengeId: input.challengeId,
        method: AuthenticationDeliveryMethod.EMAIL,
        origin,
        recipientSnapshot: input.recipientSnapshot,
        idempotencyKey: input.idempotencyKey,
        templateProtocolVersion: input.templateProtocolVersion,
        retentionExpiresAt: input.retentionExpiresAt,
      },
      select: {
        id: true,
        challengeId: true,
        method: true,
        origin: true,
        idempotencyKey: true,
      },
    });
  }

  private async lockChallengeForResend(
    transaction: Prisma.TransactionClient,
    challengeId: string,
  ): Promise<ResendChallengeRow | null> {
    const rows = await transaction.$queryRaw<ResendChallengeRow[]>(Prisma.sql`
      SELECT
        "id",
        "normalizedIdentity",
        "expiresAt",
        "failedAttemptCount",
        "maxAttempts",
        "consumedAt",
        "lockedAt",
        "encryptedProof",
        "proofEncryptionIv",
        "proofEncryptionTag"
      FROM "AuthenticationChallenge"
      WHERE "id" = ${challengeId}
      FOR UPDATE
    `);

    return rows[0] ?? null;
  }

  private isChallengeAvailableForResend(
    challenge: ResendChallengeRow | null,
    operationNow: Date,
  ): challenge is ResendChallengeRow {
    return (
      challenge !== null &&
      challenge.consumedAt === null &&
      challenge.lockedAt === null &&
      challenge.expiresAt > operationNow &&
      challenge.failedAttemptCount < challenge.maxAttempts &&
      challenge.encryptedProof !== null &&
      challenge.proofEncryptionIv !== null &&
      challenge.proofEncryptionTag !== null
    );
  }

  private async applyOwnedTransition(
    deliveryId: string,
    leaseId: string,
    createData: (
      operationNow: Date,
    ) => Prisma.AuthenticationChallengeDeliveryUpdateManyMutationInput,
  ): Promise<AuthenticationDeliveryTransitionOutcome> {
    return this.prisma.$transaction(async (transaction) => {
      const operationNow = await this.getOperationTimestamp(transaction);
      const result =
        await transaction.authenticationChallengeDelivery.updateMany({
          where: {
            id: deliveryId,
            status: AuthenticationDeliveryStatus.PROCESSING,
            processingLeaseId: leaseId,
            processingLeaseExpiresAt: { gt: operationNow },
          },
          data: createData(operationNow),
        });

      return result.count === 1
        ? AuthenticationDeliveryTransitionOutcome.APPLIED
        : AuthenticationDeliveryTransitionOutcome.LEASE_LOST;
    });
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
        'Authentication delivery operation timestamp is unavailable.',
      );
    }

    return operationNow;
  }
}
