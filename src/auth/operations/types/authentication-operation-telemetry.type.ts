import type { AuthenticationOperationDenial } from '../../../generated/prisma/enums';
import type { AuthenticationOperationFailure } from '../errors/authentication-operation.error';
import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResult,
} from './authentication-operation.type';

// Deliberately contains no request/result object, identifiers, proof or raw error.
export type AuthenticationOperationTelemetryInput = {
  operation: AuthenticationOperationRequest['kind'];
  outcome: AuthenticationOperationResult['outcome'] | 'FAILURE';
  replayed: boolean;
  durationMs: number;
  denial?: AuthenticationOperationDenial;
  deniedPolicyIds?: readonly string[];
  failureReason?: AuthenticationOperationFailure | 'UNEXPECTED';
};

export type AuthenticationOperationTelemetryEvent = {
  event: 'AUTHENTICATION_OPERATION_COMPLETED';
  schemaVersion: 1;
  operation: AuthenticationOperationRequest['kind'] | 'UNKNOWN';
  outcome: AuthenticationOperationResult['outcome'] | 'FAILURE';
  replayed: boolean;
  durationMs: number;
  denial: AuthenticationOperationDenial | null;
  deniedPolicyIds: string[];
  failureReason: AuthenticationOperationFailure | 'UNEXPECTED' | null;
};
