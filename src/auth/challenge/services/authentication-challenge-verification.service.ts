// NestJS
import { Injectable } from '@nestjs/common';

// Prisma
import type { Prisma } from '../../../generated/prisma/client';
import { AuthenticationMethod } from '../../../generated/prisma/enums';

// Internal repositories
import {
  AuthenticationChallengeRepository,
  type LockedAuthenticationChallenge,
} from '../repositories/authentication-challenge.repository';

// Internal services
import { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';

// Internal types
import type { ChallengeProofContext } from '../types/challenge-proof.type';
import {
  ChallengeVerificationStatus,
  InternalChallengeUnavailabilityReason,
  InvalidChallengeProofKind,
  type AuthenticationChallengeVerificationInput,
  type AuthenticationChallengeVerificationResult,
  type InvalidChallengeProofResult,
} from '../types/authentication-challenge-verification.type';

// Internal utilities
import {
  parseCanonicalMagicLinkToken,
  parseCanonicalOtp,
} from '../utils/parse-canonical-challenge-proof.util';

@Injectable()
export class AuthenticationChallengeVerificationService {
  constructor(
    private readonly repository: AuthenticationChallengeRepository,
    private readonly proofService: AuthenticationChallengeProofService,
  ) {}

  async verifyAndConsumeOtpInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationChallengeVerificationInput,
  ): Promise<AuthenticationChallengeVerificationResult> {
    return this.verifyInTransaction(
      transaction,
      input,
      AuthenticationMethod.EMAIL_OTP,
    );
  }

  async verifyAndConsumeMagicLinkInTransaction(
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
    authenticationMethod: AuthenticationMethod,
  ): Promise<AuthenticationChallengeVerificationResult> {
    const challenge = await this.repository.lockByIdForUpdate(
      transaction,
      input.challengeId,
    );

    if (!challenge) {
      return this.unavailable(InternalChallengeUnavailabilityReason.NOT_FOUND);
    }

    const operationNow =
      await this.repository.getOperationTimestamp(transaction);
    const unavailable = await this.resolveUnavailableState(
      transaction,
      challenge,
      input.expectedPurpose,
      operationNow,
    );

    if (unavailable) {
      return unavailable;
    }

    const context: ChallengeProofContext = {
      challengeId: challenge.id,
      purpose: challenge.purpose,
      normalizedIdentity: challenge.normalizedIdentity,
    };

    if (authenticationMethod === AuthenticationMethod.EMAIL_OTP) {
      return this.verifyOtp(
        transaction,
        challenge,
        context,
        input.proof,
        operationNow,
      );
    }

    return this.verifyMagicLink(
      transaction,
      challenge,
      context,
      input.proof,
      operationNow,
    );
  }

  private async resolveUnavailableState(
    transaction: Prisma.TransactionClient,
    challenge: LockedAuthenticationChallenge,
    expectedPurpose: LockedAuthenticationChallenge['purpose'],
    operationNow: Date,
  ): Promise<AuthenticationChallengeVerificationResult | null> {
    if (challenge.purpose !== expectedPurpose) {
      return this.unavailable(
        InternalChallengeUnavailabilityReason.PURPOSE_MISMATCH,
      );
    }

    if (challenge.consumedAt) {
      return this.unavailable(InternalChallengeUnavailabilityReason.CONSUMED);
    }

    if (challenge.lockedAt) {
      return this.unavailable(InternalChallengeUnavailabilityReason.LOCKED);
    }

    if (challenge.failedAttemptCount >= challenge.maxAttempts) {
      await this.repository.enforceAttemptLimitLock(
        transaction,
        challenge.id,
        operationNow,
      );
      return this.unavailable(InternalChallengeUnavailabilityReason.LOCKED);
    }

    if (challenge.expiresAt.getTime() <= operationNow.getTime()) {
      await this.repository.clearExpiredEnvelope(
        transaction,
        challenge.id,
        operationNow,
      );
      return this.unavailable(InternalChallengeUnavailabilityReason.EXPIRED);
    }

    return null;
  }

  private async verifyOtp(
    transaction: Prisma.TransactionClient,
    challenge: LockedAuthenticationChallenge,
    context: ChallengeProofContext,
    otp: string,
    operationNow: Date,
  ): Promise<AuthenticationChallengeVerificationResult> {
    try {
      parseCanonicalOtp(otp);
    } catch {
      return this.invalidProof(
        InvalidChallengeProofKind.MALFORMED,
        false,
        challenge.failedAttemptCount,
        challenge.maxAttempts,
        challenge.lockedAt,
      );
    }

    const matches = this.proofService.verifyOtp(
      context,
      otp,
      challenge.otpHash,
      challenge.hashProtocolVersion,
      challenge.hashKeyVersion,
    );

    if (!matches) {
      const transition = await this.repository.recordOtpFailure(
        transaction,
        challenge.id,
        operationNow,
      );

      return this.invalidProof(
        InvalidChallengeProofKind.MISMATCH,
        true,
        transition.failedAttemptCount,
        transition.maxAttempts,
        transition.lockedAt,
      );
    }

    return this.consume(
      transaction,
      challenge,
      operationNow,
      AuthenticationMethod.EMAIL_OTP,
    );
  }

  private async verifyMagicLink(
    transaction: Prisma.TransactionClient,
    challenge: LockedAuthenticationChallenge,
    context: ChallengeProofContext,
    token: string,
    operationNow: Date,
  ): Promise<AuthenticationChallengeVerificationResult> {
    try {
      parseCanonicalMagicLinkToken(token);
    } catch {
      return this.invalidProof(
        InvalidChallengeProofKind.MALFORMED,
        false,
        challenge.failedAttemptCount,
        challenge.maxAttempts,
        challenge.lockedAt,
      );
    }

    const matches = this.proofService.verifyMagicLinkToken(
      context,
      token,
      challenge.linkTokenHash,
      challenge.hashProtocolVersion,
      challenge.hashKeyVersion,
    );

    if (!matches) {
      return this.invalidProof(
        InvalidChallengeProofKind.MISMATCH,
        false,
        challenge.failedAttemptCount,
        challenge.maxAttempts,
        challenge.lockedAt,
      );
    }

    return this.consume(
      transaction,
      challenge,
      operationNow,
      AuthenticationMethod.EMAIL_MAGIC_LINK,
    );
  }

  private async consume(
    transaction: Prisma.TransactionClient,
    challenge: LockedAuthenticationChallenge,
    operationNow: Date,
    authenticationMethod: AuthenticationMethod,
  ): Promise<AuthenticationChallengeVerificationResult> {
    await this.repository.consume(transaction, challenge.id, operationNow);

    return {
      status: ChallengeVerificationStatus.VERIFIED,
      challenge: {
        id: challenge.id,
        normalizedIdentity: challenge.normalizedIdentity,
        purpose: challenge.purpose,
        userId: challenge.userId,
        boundSessionId: challenge.boundSessionId,
        authenticationMethod,
        authenticatedAt: operationNow,
        consumedAt: operationNow,
      },
    };
  }

  private invalidProof(
    kind: InvalidChallengeProofKind,
    attemptConsumed: boolean,
    failedAttemptCount: number,
    maxAttempts: number,
    lockedAt: Date | null,
  ): InvalidChallengeProofResult {
    return {
      status: ChallengeVerificationStatus.INVALID_PROOF,
      kind,
      attemptConsumed,
      failedAttemptCount,
      attemptsRemaining: Math.max(0, maxAttempts - failedAttemptCount),
      locked: lockedAt !== null,
      lockedAt,
    };
  }

  private unavailable(
    internalReason: InternalChallengeUnavailabilityReason,
  ): AuthenticationChallengeVerificationResult {
    return {
      status: ChallengeVerificationStatus.UNAVAILABLE,
      internalReason,
    };
  }
}
