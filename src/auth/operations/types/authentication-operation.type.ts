import type {
  AuthenticationDeliveryOrigin,
  AuthenticationOperationDenial,
} from '../../../generated/prisma/enums';

import type { AuthenticationSignInRequestInput } from '../../challenge/types/authentication-challenge-request.type';
import type { AuthenticationResendAdmissionInput } from '../../delivery/types/authentication-delivery-admission.type';

export type AuthenticationOperationRequest =
  | {
      kind: 'SIGN_IN_REQUEST';
      input: Omit<AuthenticationSignInRequestInput, 'idempotencyKey'>;
    }
  | {
      kind: 'RESEND';
      input: Omit<AuthenticationResendAdmissionInput, 'idempotencyKey'>;
    };

/** Historical admission decision, not current challenge/Delivery eligibility or authority. */
export type AuthenticationOperationResult =
  | {
      outcome: 'CREATED';
      challengeId: string;
      challengeExpiresAt: Date | null;
      deliveryId: string;
      deliveryOrigin: AuthenticationDeliveryOrigin;
      admissionNowMicros: bigint;
    }
  | { outcome: 'REUSED'; challengeId: string; challengeExpiresAt: Date }
  | {
      outcome: 'EXISTING';
      challengeId: string;
      deliveryId: string;
      deliveryOrigin: AuthenticationDeliveryOrigin;
    }
  | {
      outcome: 'DENIED';
      denial: AuthenticationOperationDenial;
      evaluatedAtMicros: bigint;
      retryNotBeforeMicros: bigint | null;
      remainingWaitSeconds: bigint | null;
      deniedPolicyIds: readonly string[];
    };

export type AuthenticationOperationResponse = {
  operationId: string;
  replayed: boolean;
  result: AuthenticationOperationResult;
};

export type AuthenticationOperationReconciliation =
  | { status: 'COMMITTED'; response: AuthenticationOperationResponse }
  | { status: 'NOT_COMMITTED' };
