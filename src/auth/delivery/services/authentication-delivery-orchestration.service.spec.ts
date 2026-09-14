import {
  AuthenticationChallengePurpose,
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
} from '../../../generated/prisma/enums';

import { AuthenticationDeliveryRepository } from '../repositories/authentication-delivery.repository';
import {
  AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
  AuthenticationDeliveryCancellationReason,
  AuthenticationDeliveryClaimKind,
  AuthenticationDeliveryTransitionOutcome,
  type AuthenticationDeliveryChallengeState,
  type ClaimedAuthenticationDelivery,
} from '../types/authentication-delivery.type';
import { AuthenticationChallengeProofEncryptionService } from '../../challenge/services/authentication-challenge-proof-encryption.service';
import { AuthenticationDeliveryOrchestrationService } from './authentication-delivery-orchestration.service';
import { AuthenticationDeliveryPolicyService } from './authentication-delivery-policy.service';
import { AuthenticationEmailTemplateService } from './authentication-email-template.service';
import { AuthenticationMagicLinkService } from './authentication-magic-link.service';

describe('AuthenticationDeliveryOrchestrationService', () => {
  const operationNow = new Date('2026-09-14T12:00:00.000Z');
  const delivery: ClaimedAuthenticationDelivery = {
    id: 'delivery-id',
    challengeId: '123e4567-e89b-42d3-a456-426614174000',
    method: AuthenticationDeliveryMethod.EMAIL,
    origin: AuthenticationDeliveryOrigin.INITIAL,
    recipientSnapshot: 'student@example.edu',
    idempotencyKey: 'delivery-idempotency-key',
    templateProtocolVersion: 1,
    attemptCount: 1,
    leaseId: '123e4567-e89b-42d3-a456-426614174001',
    leaseExpiresAt: new Date('2026-09-14T12:00:45.000Z'),
    claimKind: AuthenticationDeliveryClaimKind.NORMAL,
  };
  const challenge: AuthenticationDeliveryChallengeState = {
    id: delivery.challengeId,
    normalizedIdentity: 'student@example.edu',
    purpose: AuthenticationChallengePurpose.SIGN_IN,
    expiresAt: new Date('2026-09-14T12:10:00.000Z'),
    failedAttemptCount: 0,
    maxAttempts: 5,
    consumedAt: null,
    lockedAt: null,
    encryptedProof: Uint8Array.from([1]),
    proofEncryptionIv: Uint8Array.from({ length: 12 }, () => 2),
    proofEncryptionTag: Uint8Array.from({ length: 16 }, () => 3),
    encryptionProtocolVersion: 1,
    encryptionKeyVersion: 1,
  };
  const content = {
    recipient: delivery.recipientSnapshot,
    from: 'Unicon <noreply@uniconnection.app>',
    subject: '482731 — Your Unicon sign-in code',
    html: '<p>email</p>',
    text: 'email',
    inlineAttachments: [],
  };

  const repository = {
    getOwnedChallengeState: jest.fn(),
    getOwnedOperationTimestamp: jest.fn(),
    markSent: jest.fn(),
    scheduleRetryAfter: jest.fn(),
    markFailed: jest.fn(),
    markInternalFailure: jest.fn(),
    cancelOwnedDelivery: jest.fn(),
  };
  const encryptionService = { decrypt: jest.fn() };
  const magicLinkService = { buildVerificationUrl: jest.fn() };
  const templateService = { render: jest.fn() };
  const provider = { submit: jest.fn() };
  const policy = {
    retryJitterPercent: 20,
    minValidityRemainingSeconds: 120,
    getRetryDelaySeconds: jest.fn(),
  };
  const randomSource = { randomUnit: jest.fn() };
  let service: AuthenticationDeliveryOrchestrationService;
  let loggerError: jest.SpyInstance;

  beforeAll(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterAll(() => {
    loggerError.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    repository.getOwnedChallengeState.mockResolvedValue({
      outcome: 'AVAILABLE',
      operationNow,
      challenge,
    });
    repository.getOwnedOperationTimestamp.mockResolvedValue(operationNow);
    repository.markSent.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.APPLIED,
    );
    repository.scheduleRetryAfter.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.APPLIED,
    );
    repository.markFailed.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.APPLIED,
    );
    repository.markInternalFailure.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.APPLIED,
    );
    repository.cancelOwnedDelivery.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.APPLIED,
    );
    encryptionService.decrypt.mockReturnValue({
      otp: '482731',
      linkToken: 'canonical-link-token',
    });
    magicLinkService.buildVerificationUrl.mockReturnValue(
      'https://uniconnection.app/auth/verify?challengeId=id&token=token',
    );
    templateService.render.mockReturnValue(content);
    provider.submit.mockResolvedValue({
      outcome: 'ACCEPTED',
      providerMessageId: 'provider-message-id',
    });
    policy.getRetryDelaySeconds.mockReturnValue(5);
    randomSource.randomUnit.mockReturnValue(0.5);

    service = new AuthenticationDeliveryOrchestrationService(
      repository as unknown as AuthenticationDeliveryRepository,
      encryptionService as unknown as AuthenticationChallengeProofEncryptionService,
      magicLinkService as unknown as AuthenticationMagicLinkService,
      templateService as unknown as AuthenticationEmailTemplateService,
      provider,
      policy as unknown as AuthenticationDeliveryPolicyService,
      randomSource,
    );
  });

  it('uses fresh challenge state and marks an accepted submission sent', async () => {
    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'SENT',
    });

    expect(repository.getOwnedChallengeState).toHaveBeenNthCalledWith(
      1,
      delivery.id,
      delivery.leaseId,
      delivery.challengeId,
    );
    expect(encryptionService.decrypt).toHaveBeenCalledWith(
      {
        challengeId: challenge.id,
        purpose: challenge.purpose,
        normalizedIdentity: challenge.normalizedIdentity,
      },
      {
        encryptedProof: challenge.encryptedProof,
        proofEncryptionIv: challenge.proofEncryptionIv,
        proofEncryptionTag: challenge.proofEncryptionTag,
        encryptionProtocolVersion: challenge.encryptionProtocolVersion,
        encryptionKeyVersion: challenge.encryptionKeyVersion,
      },
    );
    expect(provider.submit).toHaveBeenCalledWith({
      content,
      deliveryId: delivery.id,
      idempotencyKey: delivery.idempotencyKey,
      templateProtocolVersion: delivery.templateProtocolVersion,
    });
    expect(repository.markSent).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      'provider-message-id',
    );
  });

  it.each([
    [
      { consumedAt: operationNow },
      AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
    ],
    [
      { lockedAt: operationNow },
      AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
    ],
    [
      { expiresAt: operationNow },
      AuthenticationDeliveryCancellationReason.CHALLENGE_UNAVAILABLE,
    ],
    [
      { expiresAt: new Date('2026-09-14T12:01:59.999Z') },
      AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
    ],
  ])(
    'cancels an unavailable challenge using reason %s',
    async (change, reason) => {
      repository.getOwnedChallengeState.mockResolvedValue({
        outcome: 'AVAILABLE',
        operationNow,
        challenge: { ...challenge, ...change },
      });

      await expect(service.process(delivery)).resolves.toEqual({
        outcome: 'CANCELLED',
      });
      expect(repository.cancelOwnedDelivery).toHaveBeenCalledWith(
        delivery.id,
        delivery.leaseId,
        reason,
      );
      expect(encryptionService.decrypt).not.toHaveBeenCalled();
      expect(provider.submit).not.toHaveBeenCalled();
    },
  );

  it('rechecks DB time and closes the delivery window before submission', async () => {
    repository.getOwnedOperationTimestamp.mockResolvedValue(
      new Date('2026-09-14T12:08:00.001Z'),
    );

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'CANCELLED',
    });
    expect(provider.submit).not.toHaveBeenCalled();
    expect(repository.cancelOwnedDelivery).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
    );
  });

  it('terminalizes a corrupt or partial envelope as an internal invariant', async () => {
    repository.getOwnedChallengeState.mockResolvedValue({
      outcome: 'AVAILABLE',
      operationNow,
      challenge: { ...challenge, proofEncryptionTag: null },
    });

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'FAILED',
    });
    expect(repository.markInternalFailure).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
    );
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('terminalizes unsupported crypto/template failures without retrying', async () => {
    encryptionService.decrypt.mockImplementation(() => {
      throw new Error('unsupported secret configuration');
    });

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'FAILED',
    });
    expect(repository.markInternalFailure).toHaveBeenCalledTimes(1);
    expect(repository.scheduleRetryAfter).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith({
      event: 'AUTHENTICATION_DELIVERY_INVARIANT_FAILURE',
      deliveryId: delivery.id,
      challengeId: delivery.challengeId,
      attemptCount: delivery.attemptCount,
      templateProtocolVersion: delivery.templateProtocolVersion,
    });
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain(
      'canonical-link-token',
    );
  });

  it('schedules a provider retry using persisted jitter and Retry-After maximum', async () => {
    randomSource.randomUnit.mockReturnValue(0);
    provider.submit.mockResolvedValue({
      outcome: 'RETRYABLE',
      retryKind: 'SAFE_RETRY',
      safeFailureCode: 'RESEND_RATE_LIMITED',
      retryAfterSeconds: 9,
    });

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    expect(repository.scheduleRetryAfter).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      9,
      'RESEND_RATE_LIMITED',
    );
    expect(randomSource.randomUnit).toHaveBeenCalledTimes(1);
  });

  it('cancels instead of scheduling a retry outside the delivery window', async () => {
    provider.submit.mockResolvedValue({
      outcome: 'RETRYABLE',
      retryKind: 'SAFE_RETRY',
      safeFailureCode: 'RESEND_RATE_LIMITED',
      retryAfterSeconds: 481,
    });

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'CANCELLED',
    });
    expect(repository.cancelOwnedDelivery).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      AuthenticationDeliveryCancellationReason.DELIVERY_WINDOW_CLOSED,
    );
    expect(repository.scheduleRetryAfter).not.toHaveBeenCalled();
  });

  it('treats a thrown provider submission as ambiguous and keeps the same delivery', async () => {
    provider.submit.mockRejectedValue(new Error('secret provider response'));

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    expect(repository.scheduleRetryAfter).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      5,
      'EMAIL_PROVIDER_OUTCOME_UNKNOWN',
    );
  });

  it('still performs a controlled retry if the post-provider state read is transiently unavailable', async () => {
    provider.submit.mockResolvedValue({
      outcome: 'RETRYABLE',
      retryKind: 'AMBIGUOUS_RETRY',
      safeFailureCode: 'RESEND_SERVER_OUTCOME_UNKNOWN',
    });
    repository.getOwnedChallengeState
      .mockResolvedValueOnce({ outcome: 'AVAILABLE', operationNow, challenge })
      .mockRejectedValueOnce(new Error('database read unavailable'));

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    expect(repository.scheduleRetryAfter).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      5,
      'RESEND_SERVER_OUTCOME_UNKNOWN',
    );
  });

  it('treats an invalid normalized provider retry hint as an internal invariant', async () => {
    provider.submit.mockResolvedValue({
      outcome: 'RETRYABLE',
      retryKind: 'SAFE_RETRY',
      safeFailureCode: 'RESEND_RATE_LIMITED',
      retryAfterSeconds: Number.NaN,
    });

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'FAILED',
    });
    expect(repository.markInternalFailure).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
    );
  });

  it('fails after the fifth processing claim without a sixth retry', async () => {
    policy.getRetryDelaySeconds.mockReturnValue(null);
    provider.submit.mockResolvedValue({
      outcome: 'RETRYABLE',
      retryKind: 'AMBIGUOUS_RETRY',
      safeFailureCode: 'RESEND_SERVER_OUTCOME_UNKNOWN',
    });

    await expect(
      service.process({ ...delivery, attemptCount: 5 }),
    ).resolves.toEqual({ outcome: 'FAILED' });
    expect(repository.markFailed).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED,
    );
    expect(repository.scheduleRetryAfter).not.toHaveBeenCalled();
  });

  it('turns a known pre-submission infrastructure error into a controlled retry', async () => {
    repository.getOwnedChallengeState.mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'RETRY_SCHEDULED',
    });
    expect(repository.scheduleRetryAfter).toHaveBeenCalledWith(
      delivery.id,
      delivery.leaseId,
      5,
      'INTERNAL_DELIVERY_TRANSIENT',
    );
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it('does not let a stale worker transition after losing its lease', async () => {
    repository.markSent.mockResolvedValue(
      AuthenticationDeliveryTransitionOutcome.LEASE_LOST,
    );

    await expect(service.process(delivery)).resolves.toEqual({
      outcome: 'LEASE_LOST',
    });
  });
});
import { Logger } from '@nestjs/common';
