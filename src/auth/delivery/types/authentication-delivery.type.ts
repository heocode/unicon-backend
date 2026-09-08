import type {
  AuthenticationDeliveryMethod,
  AuthenticationDeliveryOrigin,
} from '../../../generated/prisma/enums';

export enum AuthenticationDeliveryClaimKind {
  NORMAL = 'NORMAL',
  EXPIRED_LEASE_RECLAIM = 'EXPIRED_LEASE_RECLAIM',
}

export enum AuthenticationDeliveryTransitionOutcome {
  APPLIED = 'APPLIED',
  LEASE_LOST = 'LEASE_LOST',
}

export enum AuthenticationDeliveryCancellationReason {
  DELIVERY_WINDOW_CLOSED = 'DELIVERY_WINDOW_CLOSED',
  CHALLENGE_UNAVAILABLE = 'CHALLENGE_UNAVAILABLE',
  SUPERSEDED_BY_RESEND = 'SUPERSEDED_BY_RESEND',
}

export const AUTHENTICATION_DELIVERY_PROCESSING_ATTEMPTS_EXHAUSTED =
  'PROCESSING_ATTEMPTS_EXHAUSTED';

export type CreateInitialAuthenticationDeliveryInput = {
  challengeId: string;
  recipientSnapshot: string;
  idempotencyKey: string;
  templateProtocolVersion: number;
  retentionExpiresAt: Date;
};

export type CreateResendAuthenticationDeliveryInput = {
  challengeId: string;
  idempotencyKey: string;
  templateProtocolVersion: number;
  retentionExpiresAt: Date;
};

export type CreatedAuthenticationDelivery = {
  id: string;
  challengeId: string;
  method: AuthenticationDeliveryMethod;
  origin: AuthenticationDeliveryOrigin;
  idempotencyKey: string;
};

export type CreateResendAuthenticationDeliveryResult =
  | {
      outcome: 'CREATED';
      delivery: CreatedAuthenticationDelivery;
      supersededDeliveryCount: number;
    }
  | { outcome: 'CHALLENGE_UNAVAILABLE' };

export type ClaimedAuthenticationDelivery = {
  id: string;
  challengeId: string;
  method: AuthenticationDeliveryMethod;
  origin: AuthenticationDeliveryOrigin;
  recipientSnapshot: string;
  idempotencyKey: string;
  templateProtocolVersion: number;
  attemptCount: number;
  leaseId: string;
  leaseExpiresAt: Date;
  claimKind: AuthenticationDeliveryClaimKind;
};
