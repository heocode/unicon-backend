// NestJS
import { Injectable, Logger } from '@nestjs/common';

// Prisma
import { AuthenticationDeliveryMethod } from '../../../generated/prisma/enums';

// Internal ports
import { AuthenticationEmailProviderPort } from '../ports/authentication-email-provider.port';

// Internal repositories
import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';

// Internal services
import { AuthenticationChallengeProofEncryptionService } from '../../challenge/services/authentication-challenge-proof-encryption.service';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';
import { AuthenticationDeliveryRandomSourceService } from './authentication-delivery-random-source.service';
import { AuthenticationEmailTemplateService } from './authentication-email-template.service';
import { AuthenticationMagicLinkService } from './authentication-magic-link.service';

// Internal types
import {
  AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
  AuthenticationDeliveryCancellationReason,
  AuthenticationDeliveryTransitionOutcome,
  type AuthenticationDeliveryChallengeState,
  type ClaimedAuthenticationDelivery,
  type OwnedAuthenticationDeliveryChallengeResult,
} from '../types/authentication-delivery.type';
import type { AuthenticationDeliveryOrchestrationResult } from '../types/authentication-delivery-orchestration.type';
import {
  type AuthenticationEmailContent,
  type AuthenticationEmailProviderResult,
  AuthenticationEmailRetryKind,
} from '../types/authentication-email-provider.type';
import type { TransientChallengeDeliveryProof } from '../../challenge/types/challenge-proof.type';

const INTERNAL_TRANSIENT_FAILURE_CODE = 'INTERNAL_DELIVERY_TRANSIENT';

@Injectable()
export class AuthenticationDeliveryOrchestrationService {
  private readonly logger = new Logger(
    AuthenticationDeliveryOrchestrationService.name,
  );

  constructor(
    private readonly repository: AuthenticationDeliveryRepository,
    private readonly encryptionService: AuthenticationChallengeProofEncryptionService,
    private readonly magicLinkService: AuthenticationMagicLinkService,
    private readonly templateService: AuthenticationEmailTemplateService,
    private readonly provider: AuthenticationEmailProviderPort,
    private readonly policy: AuthenticationDeliveryPolicyService,
    private readonly randomSource: AuthenticationDeliveryRandomSourceService,
  ) {}

  async process(
    delivery: ClaimedAuthenticationDelivery,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    let freshState: OwnedAuthenticationDeliveryChallengeResult;

    try {
      freshState = await this.repository.getOwnedChallengeState(
        delivery.id,
        delivery.leaseId,
        delivery.challengeId,
      );
    } catch {
      return this.handleTransientBeforeSubmission(delivery);
    }

    if (freshState.outcome === 'LEASE_LOST') {
      return { outcome: 'LEASE_LOST' };
    }

    const unavailableReason = this.getUnavailableReason(
      freshState.challenge,
      freshState.operationNow,
    );
    if (unavailableReason !== null) {
      return this.cancel(delivery, unavailableReason);
    }

    let proof: TransientChallengeDeliveryProof;
    let content: AuthenticationEmailContent;

    try {
      this.assertCompleteEnvelope(freshState.challenge);
      if (delivery.method !== AuthenticationDeliveryMethod.EMAIL) {
        throw new Error('Authentication delivery method is unsupported.');
      }
      if (
        delivery.recipientSnapshot !== freshState.challenge.normalizedIdentity
      ) {
        throw new Error('Authentication delivery recipient is inconsistent.');
      }
      proof = this.encryptionService.decrypt(
        {
          challengeId: freshState.challenge.id,
          purpose: freshState.challenge.purpose,
          normalizedIdentity: freshState.challenge.normalizedIdentity,
        },
        {
          encryptedProof: freshState.challenge.encryptedProof,
          proofEncryptionIv: freshState.challenge.proofEncryptionIv,
          proofEncryptionTag: freshState.challenge.proofEncryptionTag,
          encryptionProtocolVersion:
            freshState.challenge.encryptionProtocolVersion,
          encryptionKeyVersion: freshState.challenge.encryptionKeyVersion,
        },
      );
      const magicLinkUrl = this.magicLinkService.buildVerificationUrl({
        challengeId: freshState.challenge.id,
        linkToken: proof.linkToken,
      });
      content = this.templateService.render({
        templateProtocolVersion: delivery.templateProtocolVersion,
        recipient: delivery.recipientSnapshot,
        otp: proof.otp,
        magicLinkUrl,
      });
    } catch {
      return this.markInternalFailure(delivery);
    }

    let preSubmissionNow: Date | null;
    try {
      preSubmissionNow = await this.repository.getOwnedOperationTimestamp(
        delivery.id,
        delivery.leaseId,
      );
    } catch {
      return this.handleTransientBeforeSubmission(delivery);
    }

    if (preSubmissionNow === null) {
      return { outcome: 'LEASE_LOST' };
    }
    if (!this.hasMinimumValidity(freshState.challenge, preSubmissionNow)) {
      return this.cancel(
        delivery,
        AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
      );
    }

    let providerResult: AuthenticationEmailProviderResult;
    try {
      providerResult = await this.provider.submit({
        content,
        deliveryId: delivery.id,
        idempotencyKey: delivery.idempotencyKey,
        templateProtocolVersion: delivery.templateProtocolVersion,
      });
    } catch {
      providerResult = {
        outcome: 'RETRYABLE',
        retryKind: AuthenticationEmailRetryKind.AMBIGUOUS_RETRY,
        safeFailureCode: 'EMAIL_PROVIDER_OUTCOME_UNKNOWN',
      };
    }

    return this.handleProviderResult(delivery, providerResult);
  }

  private async handleProviderResult(
    delivery: ClaimedAuthenticationDelivery,
    result: AuthenticationEmailProviderResult,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    if (result.outcome === 'ACCEPTED') {
      return this.mapTransition(
        await this.repository.markSent(
          delivery.id,
          delivery.leaseId,
          result.providerMessageId,
        ),
        'SENT',
      );
    }

    if (result.outcome === 'PERMANENT_FAILURE') {
      return this.mapTransition(
        await this.repository.markFailed(
          delivery.id,
          delivery.leaseId,
          result.safeFailureCode,
        ),
        'FAILED',
      );
    }

    return this.scheduleRetry(
      delivery,
      result.safeFailureCode,
      result.retryAfterSeconds,
    );
  }

  private async handleTransientBeforeSubmission(
    delivery: ClaimedAuthenticationDelivery,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    let policyDelay: number | null;
    try {
      policyDelay = this.getJitteredPolicyDelay(delivery.attemptCount);
    } catch {
      return this.markInternalFailure(delivery);
    }
    if (policyDelay === null) {
      return this.mapTransition(
        await this.repository.markFailed(
          delivery.id,
          delivery.leaseId,
          AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
        ),
        'FAILED',
      );
    }

    return this.mapTransition(
      await this.repository.scheduleRetryAfter(
        delivery.id,
        delivery.leaseId,
        policyDelay,
        INTERNAL_TRANSIENT_FAILURE_CODE,
      ),
      'RETRY_SCHEDULED',
    );
  }

  private async scheduleRetry(
    delivery: ClaimedAuthenticationDelivery,
    safeFailureCode: string,
    retryAfterSeconds?: number,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    if (
      retryAfterSeconds !== undefined &&
      (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0)
    ) {
      return this.markInternalFailure(delivery);
    }

    let policyDelay: number | null;
    try {
      policyDelay = this.getJitteredPolicyDelay(delivery.attemptCount);
    } catch {
      return this.markInternalFailure(delivery);
    }
    if (policyDelay === null) {
      return this.mapTransition(
        await this.repository.markFailed(
          delivery.id,
          delivery.leaseId,
          AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
        ),
        'FAILED',
      );
    }

    const effectiveDelay = Math.max(policyDelay, retryAfterSeconds ?? 0);
    let state: OwnedAuthenticationDeliveryChallengeResult;

    try {
      state = await this.repository.getOwnedChallengeState(
        delivery.id,
        delivery.leaseId,
        delivery.challengeId,
      );
    } catch {
      return this.mapTransition(
        await this.repository.scheduleRetryAfter(
          delivery.id,
          delivery.leaseId,
          effectiveDelay,
          safeFailureCode,
        ),
        'RETRY_SCHEDULED',
      );
    }

    if (state.outcome === 'LEASE_LOST') {
      return { outcome: 'LEASE_LOST' };
    }

    const unavailableReason = this.getUnavailableReason(
      state.challenge,
      state.operationNow,
    );
    if (unavailableReason !== null) {
      return this.cancel(delivery, unavailableReason);
    }

    const nextAttemptAt = new Date(
      state.operationNow.getTime() + effectiveDelay * 1_000,
    );
    if (!this.hasMinimumValidity(state.challenge, nextAttemptAt)) {
      return this.cancel(
        delivery,
        AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
      );
    }

    return this.mapTransition(
      await this.repository.scheduleRetryAfter(
        delivery.id,
        delivery.leaseId,
        effectiveDelay,
        safeFailureCode,
      ),
      'RETRY_SCHEDULED',
    );
  }

  private getJitteredPolicyDelay(attemptCount: number): number | null {
    const policyDelay = this.policy.getRetryDelaySeconds(attemptCount);
    if (policyDelay === null) {
      return null;
    }

    const randomUnit = this.randomSource.randomUnit();
    if (!Number.isFinite(randomUnit) || randomUnit < 0 || randomUnit >= 1) {
      throw new Error('Authentication delivery randomness is invalid.');
    }

    const jitterFraction = this.policy.retryJitterPercent / 100;
    return policyDelay * (1 - jitterFraction + 2 * jitterFraction * randomUnit);
  }

  private getUnavailableReason(
    challenge: AuthenticationDeliveryChallengeState,
    operationNow: Date,
  ): AuthenticationDeliveryCancellationReason | null {
    if (
      challenge.consumedAt !== null ||
      challenge.lockedAt !== null ||
      challenge.failedAttemptCount >= challenge.maxAttempts ||
      challenge.expiresAt <= operationNow
    ) {
      return AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE;
    }

    return this.hasMinimumValidity(challenge, operationNow)
      ? null
      : AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED;
  }

  private hasMinimumValidity(
    challenge: AuthenticationDeliveryChallengeState,
    referenceTime: Date,
  ): boolean {
    return (
      challenge.expiresAt.getTime() - referenceTime.getTime() >=
      this.policy.minValidityRemainingSeconds * 1_000
    );
  }

  private assertCompleteEnvelope(
    challenge: AuthenticationDeliveryChallengeState,
  ): asserts challenge is AuthenticationDeliveryChallengeState & {
    encryptedProof: Uint8Array;
    proofEncryptionIv: Uint8Array;
    proofEncryptionTag: Uint8Array;
  } {
    if (
      challenge.encryptedProof === null ||
      challenge.proofEncryptionIv === null ||
      challenge.proofEncryptionTag === null
    ) {
      throw new Error('Authentication challenge proof envelope is incomplete.');
    }
  }

  private async cancel(
    delivery: ClaimedAuthenticationDelivery,
    reason: AuthenticationDeliveryCancellationReason,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    return this.mapTransition(
      await this.repository.cancelOwnedDelivery(
        delivery.id,
        delivery.leaseId,
        reason,
      ),
      'CANCELLED',
    );
  }

  private async markInternalFailure(
    delivery: ClaimedAuthenticationDelivery,
  ): Promise<AuthenticationDeliveryOrchestrationResult> {
    this.logger.error({
      event: 'AUTHENTICATION_DELIVERY_INVARIANT_FAILURE',
      deliveryId: delivery.id,
      challengeId: delivery.challengeId,
      attemptCount: delivery.attemptCount,
      templateProtocolVersion: delivery.templateProtocolVersion,
    });

    return this.mapTransition(
      await this.repository.markInternalFailure(delivery.id, delivery.leaseId),
      'FAILED',
    );
  }

  private mapTransition(
    transition: AuthenticationDeliveryTransitionOutcome,
    outcome: 'SENT' | 'RETRY_SCHEDULED' | 'FAILED' | 'CANCELLED',
  ): AuthenticationDeliveryOrchestrationResult {
    return transition === AuthenticationDeliveryTransitionOutcome.APPLIED
      ? { outcome }
      : { outcome: 'LEASE_LOST' };
  }
}
