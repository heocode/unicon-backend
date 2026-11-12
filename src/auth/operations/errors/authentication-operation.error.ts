export type AuthenticationOperationFailure =
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_EXPIRED'
  | 'STATE_UNAVAILABLE'
  | 'RETRY_EXHAUSTED'
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'NOT_COMMITTED';

/** Safe internal diagnostic only: never attach raw DB errors, input or causes. */
export class AuthenticationOperationError extends Error {
  constructor(readonly reason: AuthenticationOperationFailure) {
    super('Authoritative authentication operation could not be established.');
    this.name = AuthenticationOperationError.name;
  }
}
