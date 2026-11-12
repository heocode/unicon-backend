import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client';

import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';
import { canonicalizeIp } from '../../../common/utils/canonicalize-ip.util';
import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { isRetryableGcraTransactionError } from '../../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { AuthenticationDeliveryRateLimitService } from '../../rate-limit/services/authentication-delivery-rate-limit.service';
import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';
import type {
  AuthenticationResendAdmissionInput,
  AuthenticationResendAdmissionResult,
  AuthenticationInitialAdmissionInput,
  AuthenticationInitialAdmissionResult,
} from '../types/authentication-delivery-admission.type';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';

@Injectable()
export class AuthenticationDeliveryAdmissionService {
  private static readonly transactions =
    new WeakSet<Prisma.TransactionClient>();

  constructor(
    private readonly repository: AuthenticationDeliveryRepository,
    private readonly rateLimits: AuthenticationDeliveryRateLimitService,
    private readonly policy: AuthenticationDeliveryPolicyService,
  ) {}

  /** One admission per transaction. Owner supplies bounds, commit handling and retries. */
  async admitResendInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationResendAdmissionInput,
  ): Promise<AuthenticationResendAdmissionResult> {
    const captured = this.capture(input);
    return this.withAdmission(transaction, () =>
      this.admit(transaction, captured, 'RESEND'),
    );
  }

  /** Strict INITIAL admission for a newly created challenge in the same transaction. */
  async admitInitialInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationInitialAdmissionInput,
  ): Promise<AuthenticationInitialAdmissionResult> {
    const captured = this.capture(input);
    return this.withAdmission(transaction, async () => {
      const result = await this.admit(transaction, captured, 'INITIAL');
      if (result.outcome === 'EXISTING')
        throw new GcraAdmissionInfrastructureError('INVALID_STATE');
      return result;
    });
  }

  private async withAdmission<T>(
    transaction: Prisma.TransactionClient,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      ('$connect' in transaction && transaction.$connect !== undefined) ||
      AuthenticationDeliveryAdmissionService.transactions.has(transaction)
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
    }
    AuthenticationDeliveryAdmissionService.transactions.add(transaction);
    try {
      const [row] = await transaction.$queryRaw<{ isolation: string }[]>`
        SELECT current_setting('transaction_isolation') AS "isolation"
      `;
      if (
        row?.isolation !== 'read committed' &&
        row?.isolation !== 'serializable'
      ) {
        throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
      }
      await transaction.$executeRaw`SAVEPOINT unicon_delivery_admission`;
    } catch (error) {
      throw this.failure(error);
    }
    try {
      const result = await operation();
      await transaction.$executeRaw`RELEASE SAVEPOINT unicon_delivery_admission`;
      return result;
    } catch (error) {
      try {
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_delivery_admission`;
        await transaction.$executeRaw`RELEASE SAVEPOINT unicon_delivery_admission`;
      } catch {
        throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
      }
      throw this.failure(error);
    }
  }

  private async admit(
    transaction: Prisma.TransactionClient,
    input: AuthenticationResendAdmissionInput,
    origin: 'INITIAL' | 'RESEND',
  ): Promise<AuthenticationResendAdmissionResult> {
    const context = await this.repository.getResendContextInTransaction(
      transaction,
      input.challengeId,
    );
    if (context.outcome !== 'READY') {
      if (origin === 'INITIAL' && context.outcome === 'EXISTING')
        throw new GcraAdmissionInfrastructureError('INVALID_STATE');
      return context;
    }
    const rate = await this.rateLimits.admitInTransaction(
      transaction,
      {
        challengeId: context.challengeId,
        normalizedIdentity: context.normalizedIdentity,
        ipAddress: input.ipAddress,
      },
      {
        expiresAtMicros: context.expiresAtMicros,
        minValidityRemainingSeconds: this.policy.minValidityRemainingSeconds,
      },
    );
    if ('windowOutcome' in rate) return { outcome: rate.windowOutcome };
    if (!rate.allowed)
      return {
        outcome: 'RATE_LIMITED',
        operationNowMicros: rate.operationNowMicros,
        retryNotBeforeMicros: rate.retryNotBeforeMicros,
        retryAfterSeconds: rate.retryAfterSeconds,
        deniedPolicyIds: rate.deniedPolicyIds,
      };
    // Reuses the strict persistence path under the locks already held. It cannot
    // become EXISTING/unavailable without an invariant violation in this operation.
    const created =
      origin === 'INITIAL'
        ? {
            outcome: 'CREATED' as const,
            delivery: await this.repository.createInitialDelivery(transaction, {
              ...input,
              recipientSnapshot: context.normalizedIdentity,
            }),
          }
        : await this.repository.createResendDeliveryInTransaction(
            transaction,
            input,
          );
    if (created.outcome !== 'CREATED')
      throw new GcraAdmissionInfrastructureError('INVALID_STATE');
    return { ...created, operationNowMicros: rate.operationNowMicros };
  }

  private capture(
    input: AuthenticationResendAdmissionInput,
  ): AuthenticationResendAdmissionInput {
    try {
      assertCanonicalUuid(input.challengeId);
      const ipAddress = canonicalizeIp(input.ipAddress);
      const retentionExpiresAt = new Date(input.retentionExpiresAt.getTime());
      if (
        !Number.isFinite(retentionExpiresAt.getTime()) ||
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey ||
        !Number.isSafeInteger(input.templateProtocolVersion) ||
        input.templateProtocolVersion <= 0
      ) {
        throw new Error('Invalid admission metadata.');
      }
      return {
        challengeId: input.challengeId,
        ipAddress,
        idempotencyKey: input.idempotencyKey,
        templateProtocolVersion: input.templateProtocolVersion,
        retentionExpiresAt,
      };
    } catch {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
  }

  private failure(error: unknown): GcraAdmissionInfrastructureError {
    if (isRetryableGcraTransactionError(error))
      return new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED');
    return error instanceof GcraAdmissionInfrastructureError
      ? error
      : new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
  }
}
