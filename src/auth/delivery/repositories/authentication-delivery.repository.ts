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
  type AuthenticationResendContext,
  type AuthenticationDeliveryAttemptStart,
} from '../types/authentication-delivery.type';

type OperationTimestampRow = {
  operationNow: Date;
};

type ResendChallengeRow = {
  id: string;
  normalizedIdentity: string;
  expiresAt: Date;
  expiresAtMicros: string;
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
    await this.assertCreationTransaction(transaction);
    const challenge = await this.lockChallengeForDelivery(
      transaction,
      input.challengeId,
    );
    if (!challenge) {
      throw new Error('Authentication delivery challenge is missing.');
    }
    if (await this.findUnfinishedDelivery(transaction, input.challengeId)) {
      throw new Error('Authentication delivery work already exists.');
    }
    return this.createDelivery(
      transaction,
      input,
      AuthenticationDeliveryOrigin.INITIAL,
    );
  }

  createResendDelivery(
    input: CreateResendAuthenticationDeliveryInput,
  ): Promise<CreateResendAuthenticationDeliveryResult> {
    return this.prisma.$transaction((transaction) =>
      this.createResendDeliveryInTransaction(transaction, input),
    );
  }

  /** Persistence only: the owner must compose new work with admission checks. */
  async createResendDeliveryInTransaction(
    transaction: Prisma.TransactionClient,
    input: CreateResendAuthenticationDeliveryInput,
  ): Promise<CreateResendAuthenticationDeliveryResult> {
    const context = await this.getResendContextInTransaction(
      transaction,
      input.challengeId,
    );
    if (context.outcome !== 'READY') return context;
    const delivery = await this.createDelivery(
      transaction,
      { ...input, recipientSnapshot: context.normalizedIdentity },
      AuthenticationDeliveryOrigin.RESEND,
    );
    return { outcome: 'CREATED', delivery };
  }

  /** No writes. Caller must retain this transaction and its locks through insertion. */
  async getResendContextInTransaction(
    transaction: Prisma.TransactionClient,
    challengeId: string,
  ): Promise<AuthenticationResendContext> {
    await this.assertCreationTransaction(transaction);
    const challenge = await this.lockChallengeForDelivery(
      transaction,
      challengeId,
    );
    const existing = await this.findUnfinishedDelivery(
      transaction,
      challengeId,
    );
    // Sample after both challenge and Delivery row-lock waits.
    const operationNow = await this.getOperationTimestamp(transaction);
    if (!this.isChallengeAvailableForResend(challenge, operationNow)) {
      return { outcome: 'CHALLENGE_UNAVAILABLE' };
    }
    if (existing) return { outcome: 'EXISTING', delivery: existing };
    return {
      outcome: 'READY',
      challengeId: challenge.id,
      normalizedIdentity: challenge.normalizedIdentity,
      expiresAtMicros: BigInt(challenge.expiresAtMicros),
    };
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
                  OR "challenge"."consumedAt" IS NOT NULL
                  OR "challenge"."lockedAt" IS NOT NULL
                  OR "challenge"."expiresAt" < ${operationNow}::timestamp + make_interval(secs => ${this.policy.minValidityRemainingSeconds})
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
          "processingAttemptStarted" = false,
          "nextAttemptAt" = NULL,
          "processingLeaseId" = ${leaseId}::uuid,
          "processingLeaseExpiresAt" = ${leaseExpiresAt},
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

  /** Leasing is free. Charge once when processing actually starts, after gate
   * acquisition. Existing charged attempts survive crashes and are never refunded. */
  startProcessingAttempt(
    delivery: ClaimedAuthenticationDelivery,
  ): Promise<AuthenticationDeliveryAttemptStart> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.lockPreparationState(tx, delivery);
      if (!state) return { outcome: 'LEASE_LOST' };
      const reason = this.preparationCancellation(state.challenge, state.now);
      if (reason) {
        await this.cancelPreparation(tx, delivery, state.now, reason);
        return { outcome: 'CANCELLED' };
      }
      if (state.row.processingAttemptStarted) {
        return { outcome: 'STARTED', attemptCount: state.row.attemptCount };
      }
      const result = await tx.authenticationChallengeDelivery.updateMany({
        where: {
          id: delivery.id,
          status: AuthenticationDeliveryStatus.PROCESSING,
          processingLeaseId: delivery.leaseId,
          processingLeaseExpiresAt: { gt: state.now },
          processingAttemptStarted: false,
          attemptCount: { lt: this.policy.maxProcessingAttempts },
        },
        data: {
          processingAttemptStarted: true,
          attemptCount: { increment: 1 },
          attemptedAt: state.now,
          updatedAt: state.now,
        },
      });
      return result.count === 1
        ? { outcome: 'STARTED', attemptCount: state.row.attemptCount + 1 }
        : { outcome: 'LEASE_LOST' };
    });
  }

  /** Capacity waiting changes only scheduling/lease state, never attempt budget,
   * attemptedAt, provider failure, idempotency, proof or admission accounting. */
  deferUnstartedDelivery(
    delivery: ClaimedAuthenticationDelivery,
    retryNotBeforeMicros?: bigint,
  ): Promise<'DEFERRED' | 'CANCELLED' | 'LEASE_LOST'> {
    return this.prisma.$transaction(async (tx) => {
      const state = await this.lockPreparationState(tx, delivery);
      if (!state) return 'LEASE_LOST';
      const reason = this.preparationCancellation(state.challenge, state.now);
      if (reason) {
        await this.cancelPreparation(tx, delivery, state.now, reason);
        return 'CANCELLED';
      }
      // A failure after an uncertain attempt-start commit must remain recoverable
      // under that charged lease, not become a free capacity deferral.
      if (state.row.processingAttemptStarted) return 'LEASE_LOST';
      const closeAt =
        state.challenge.expiresAt.getTime() -
        this.policy.minValidityRemainingSeconds * 1000 +
        1;
      // This is a local poll time for unknown recovery, never a provider reset promise.
      const requested =
        retryNotBeforeMicros === undefined
          ? BigInt(
              state.now.getTime() + this.policy.workerIntervalSeconds * 1000,
            )
          : (retryNotBeforeMicros + 999n) / 1000n;
      const nextAttemptAt = new Date(
        Number(requested < BigInt(closeAt) ? requested : BigInt(closeAt)),
      );
      const updated = await tx.authenticationChallengeDelivery.updateMany({
        where: {
          id: delivery.id,
          status: AuthenticationDeliveryStatus.PROCESSING,
          processingLeaseId: delivery.leaseId,
          processingLeaseExpiresAt: { gt: state.now },
          processingAttemptStarted: false,
        },
        data: {
          status: AuthenticationDeliveryStatus.PENDING,
          nextAttemptAt,
          processingLeaseId: null,
          processingLeaseExpiresAt: null,
          updatedAt: state.now,
        },
      });
      return updated.count === 1 ? 'DEFERRED' : 'LEASE_LOST';
    });
  }

  private async lockPreparationState(
    tx: Prisma.TransactionClient,
    delivery: ClaimedAuthenticationDelivery,
  ) {
    // Same challenge -> Delivery order as admission/verification; sample after waits.
    const [challenge] = await tx.$queryRaw<
      { expiresAt: Date; consumedAt: Date | null; lockedAt: Date | null }[]
    >`
      SELECT "expiresAt", "consumedAt", "lockedAt" FROM "AuthenticationChallenge"
      WHERE "id"=${delivery.challengeId} FOR UPDATE
    `;
    const [row] = await tx.$queryRaw<
      {
        attemptCount: number;
        processingAttemptStarted: boolean;
        processingLeaseExpiresAt: Date;
      }[]
    >`
      SELECT "attemptCount", "processingAttemptStarted", "processingLeaseExpiresAt"
      FROM "AuthenticationChallengeDelivery" WHERE "id"=${delivery.id}
      AND "challengeId"=${delivery.challengeId} AND "status"='PROCESSING'
      AND "processingLeaseId"=${delivery.leaseId}::uuid FOR UPDATE
    `;
    const [time] = await tx.$queryRaw<{ milliseconds: string }[]>`
      SELECT ceil(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::text AS "milliseconds"
    `;
    const now = new Date(Number(time.milliseconds));
    if (!challenge || !row || row.processingLeaseExpiresAt <= now) return null;
    return { challenge, row, now };
  }

  private preparationCancellation(
    challenge: {
      expiresAt: Date;
      consumedAt: Date | null;
      lockedAt: Date | null;
    },
    now: Date,
  ): AuthenticationDeliveryCancellationReason | null {
    if (
      challenge.consumedAt ||
      challenge.lockedAt ||
      challenge.expiresAt <= now
    )
      return AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE;
    if (
      challenge.expiresAt.getTime() - now.getTime() <
      this.policy.minValidityRemainingSeconds * 1000
    )
      return AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED;
    return null;
  }

  private async cancelPreparation(
    tx: Prisma.TransactionClient,
    delivery: ClaimedAuthenticationDelivery,
    now: Date,
    reason: AuthenticationDeliveryCancellationReason,
  ): Promise<void> {
    await tx.authenticationChallengeDelivery.updateMany({
      where: {
        id: delivery.id,
        status: AuthenticationDeliveryStatus.PROCESSING,
        processingLeaseId: delivery.leaseId,
        processingLeaseExpiresAt: { gt: now },
      },
      data: {
        status: AuthenticationDeliveryStatus.CANCELLED,
        processingAttemptStarted: false,
        processingLeaseId: null,
        processingLeaseExpiresAt: null,
        nextAttemptAt: null,
        lastSafeFailureCode: reason,
        updatedAt: now,
      },
    });
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
          "processingAttemptStarted" = false,
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

  private async assertCreationTransaction(
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    if ('$connect' in transaction && transaction.$connect !== undefined) {
      throw new Error(
        'Authentication delivery requires an interactive transaction.',
      );
    }
    const [row] = await transaction.$queryRaw<{ isolation: string }[]>`
      SELECT current_setting('transaction_isolation') AS "isolation"
    `;
    if (
      row?.isolation !== 'read committed' &&
      row?.isolation !== 'serializable'
    ) {
      throw new Error(
        'Authentication delivery transaction isolation is unsupported.',
      );
    }
    // Fails outside a real transaction, including clients without $connect.
    // This verifies scope only; the caller owns commit and rollback.
    await transaction.$executeRaw`SAVEPOINT unicon_delivery_creation`;
    await transaction.$executeRaw`RELEASE SAVEPOINT unicon_delivery_creation`;
  }

  private async findUnfinishedDelivery(
    transaction: Prisma.TransactionClient,
    challengeId: string,
  ): Promise<CreatedAuthenticationDelivery | null> {
    const rows = await transaction.$queryRaw<
      CreatedAuthenticationDelivery[]
    >(Prisma.sql`
      SELECT "id", "challengeId", "method", "origin", "idempotencyKey"
      FROM "AuthenticationChallengeDelivery"
      WHERE "challengeId" = ${challengeId} AND "status" IN ('PENDING', 'PROCESSING')
      ORDER BY "id"
      LIMIT 2
      FOR UPDATE
    `);
    if (rows.length > 1) {
      throw new Error(
        'Authentication delivery unfinished-work invariant is violated.',
      );
    }
    return rows[0] ?? null;
  }

  private async lockChallengeForDelivery(
    transaction: Prisma.TransactionClient,
    challengeId: string,
  ): Promise<ResendChallengeRow | null> {
    const rows = await transaction.$queryRaw<ResendChallengeRow[]>(Prisma.sql`
      SELECT
        "id",
        "normalizedIdentity",
        "expiresAt",
        trunc(EXTRACT(EPOCH FROM "expiresAt") * 1000000)::text AS "expiresAtMicros",
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
          data: {
            ...createData(operationNow),
            processingAttemptStarted: false,
          },
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
