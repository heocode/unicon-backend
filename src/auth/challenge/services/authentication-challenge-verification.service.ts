// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import type { Prisma } from '../../../generated/prisma/client';
import { AuthenticationMethod } from '../../../generated/prisma/enums';

// Internal repositories/services
import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { isRetryableGcraTransactionError } from '../../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { AuthenticationVerificationRateLimitService } from '../../rate-limit/services/authentication-verification-rate-limit.service';
import { AuthenticationVerificationProofOutcome as ProofOutcome } from '../../rate-limit/types/authentication-verification-rate-limit.type';
import {
  AuthenticationChallengeRepository,
  type LockedAuthenticationChallenge,
} from '../repositories/authentication-challenge.repository';
import { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';

// Internal types/utilities
import {
  ChallengeVerificationStatus,
  InternalChallengeUnavailabilityReason as Unavailable,
  InvalidChallengeProofKind,
  type AuthenticationChallengeVerificationInput,
  type AuthenticationChallengeVerificationResult,
  type InvalidChallengeProofResult,
} from '../types/authentication-challenge-verification.type';
import {
  parseCanonicalMagicLinkToken,
  parseCanonicalOtp,
} from '../utils/parse-canonical-challenge-proof.util';

@Injectable()
export class AuthenticationChallengeVerificationService {
  private static readonly transactions =
    new WeakSet<Prisma.TransactionClient>();

  constructor(
    private readonly repository: AuthenticationChallengeRepository,
    private readonly proofService: AuthenticationChallengeProofService,
    private readonly limiter: AuthenticationVerificationRateLimitService,
  ) {}

  /** Results remain provisional until the owner commits. The owner supplies
   * finite transaction/lock bounds and any bounded whole-transaction retries. */
  verifyAndConsumeOtpInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationChallengeVerificationInput,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return this.verifyInTransaction(
      transaction,
      input,
      AuthenticationMethod.EMAIL_OTP,
    );
  }

  verifyAndConsumeMagicLinkInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationChallengeVerificationInput,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return this.verifyInTransaction(
      transaction,
      input,
      AuthenticationMethod.EMAIL_MAGIC_LINK,
    );
  }

  private async verifyInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationChallengeVerificationInput,
    method: AuthenticationMethod,
  ): Promise<AuthenticationChallengeVerificationResult> {
    if (
      ('$connect' in transaction && transaction.$connect !== undefined) ||
      AuthenticationChallengeVerificationService.transactions.has(transaction)
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
    }
    AuthenticationChallengeVerificationService.transactions.add(transaction);
    // Capture before the first await. Only trusted boundary metadata belongs here.
    const captured = { ...input };
    try {
      const [row] = await transaction.$queryRaw<{ isolation: string }[]>`
        SELECT current_setting('transaction_isolation') AS "isolation"
      `;
      if (
        row?.isolation !== 'read committed' &&
        row?.isolation !== 'serializable'
      )
        throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
      await transaction.$executeRaw`SAVEPOINT unicon_challenge_verification`;
    } catch (error) {
      throw this.failure(error);
    }
    try {
      const result = await this.verify(transaction, captured, method);
      await transaction.$executeRaw`RELEASE SAVEPOINT unicon_challenge_verification`;
      return result;
    } catch (error) {
      try {
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_challenge_verification`;
        await transaction.$executeRaw`RELEASE SAVEPOINT unicon_challenge_verification`;
      } catch {
        throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
      }
      throw this.failure(error);
    }
  }

  private async verify(
    transaction: Prisma.TransactionClient,
    input: AuthenticationChallengeVerificationInput,
    method: AuthenticationMethod,
  ): Promise<AuthenticationChallengeVerificationResult> {
    const challenge = await this.repository.lockByIdForUpdate(
      transaction,
      input.challengeId,
    );
    if (!challenge) return this.unavailable(Unavailable.NOT_FOUND);
    if (challenge.purpose !== input.expectedPurpose)
      return this.unavailable(Unavailable.PURPOSE_MISMATCH);
    if (challenge.boundSessionId !== input.expectedBoundSessionId)
      return this.unavailable(Unavailable.BINDING_MISMATCH);
    if (challenge.consumedAt) return this.unavailable(Unavailable.CONSUMED);
    if (challenge.lockedAt) return this.unavailable(Unavailable.LOCKED);

    const initialNow = await this.repository.getOperationTimestamp(transaction);
    if (challenge.expiresAt <= initialNow) {
      await this.repository.clearExpiredEnvelope(
        transaction,
        challenge.id,
        initialNow,
      );
      return this.unavailable(Unavailable.EXPIRED);
    }
    try {
      if (method === AuthenticationMethod.EMAIL_OTP)
        parseCanonicalOtp(input.proof);
      else parseCanonicalMagicLinkToken(input.proof);
    } catch {
      return this.invalidProof(
        InvalidChallengeProofKind.MALFORMED,
        false,
        challenge.failedAttemptCount,
      );
    }

    let proofResult: AuthenticationChallengeVerificationResult | undefined;
    const admission = await this.limiter.evaluateInTransaction(
      transaction,
      {
        normalizedIdentity: challenge.normalizedIdentity,
        ipAddress: input.ipAddress,
        expiresAtMicros: BigInt(challenge.expiresAt.getTime()) * 1000n,
      },
      async (nowMicros) => {
        const now = new Date(Number(nowMicros / 1000n));
        const context = {
          challengeId: challenge.id,
          purpose: challenge.purpose,
          normalizedIdentity: challenge.normalizedIdentity,
        };
        const matches =
          method === AuthenticationMethod.EMAIL_OTP
            ? this.proofService.verifyOtp(
                context,
                input.proof,
                challenge.otpHash,
                challenge.hashProtocolVersion,
                challenge.hashKeyVersion,
              )
            : this.proofService.verifyMagicLinkToken(
                context,
                input.proof,
                challenge.linkTokenHash,
                challenge.hashProtocolVersion,
                challenge.hashKeyVersion,
              );
        if (!matches) {
          const transition = await this.repository.recordProofFailure(
            transaction,
            challenge.id,
            now,
          );
          proofResult = this.invalidProof(
            InvalidChallengeProofKind.MISMATCH,
            true,
            transition.failedAttemptCount,
          );
          return ProofOutcome.CANONICAL_MISMATCH;
        }
        await this.repository.consume(transaction, challenge.id, now);
        proofResult = this.verified(challenge, method, now);
        return ProofOutcome.MATCH;
      },
    );
    if (admission.outcome === 'RATE_LIMITED') {
      return {
        status: ChallengeVerificationStatus.RATE_LIMITED,
        retryAfterSeconds: admission.retryAfterSeconds,
        retryNotBeforeMicros: admission.retryNotBeforeMicros,
        deniedPolicyIds: admission.deniedPolicyIds,
      };
    }
    if (admission.outcome === 'EXPIRED') {
      await this.repository.clearExpiredEnvelope(
        transaction,
        challenge.id,
        new Date(Number(admission.operationNowMicros / 1000n)),
      );
      return this.unavailable(Unavailable.EXPIRED);
    }
    if (!proofResult)
      throw new GcraAdmissionInfrastructureError('INVALID_STATE');
    return proofResult;
  }

  private verified(
    challenge: LockedAuthenticationChallenge,
    method: AuthenticationMethod,
    now: Date,
  ): AuthenticationChallengeVerificationResult {
    return {
      status: ChallengeVerificationStatus.VERIFIED,
      challenge: {
        id: challenge.id,
        normalizedIdentity: challenge.normalizedIdentity,
        purpose: challenge.purpose,
        userId: challenge.userId,
        boundSessionId: challenge.boundSessionId,
        authenticationMethod: method,
        authenticatedAt: now,
        consumedAt: now,
      },
    };
  }

  private invalidProof(
    kind: InvalidChallengeProofKind,
    attemptConsumed: boolean,
    failedAttemptCount: number,
  ): InvalidChallengeProofResult {
    return {
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind,
      attemptConsumed,
      failedAttemptCount,
      locked: false,
      lockedAt: null,
    };
  }

  private unavailable(
    internalReason: Unavailable,
  ): AuthenticationChallengeVerificationResult {
    return { status: ChallengeVerificationStatus.UNAVAILABLE, internalReason };
  }

  private failure(error: unknown): GcraAdmissionInfrastructureError {
    if (isRetryableGcraTransactionError(error))
      return new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED');
    return error instanceof GcraAdmissionInfrastructureError
      ? error
      : new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
  }
}
