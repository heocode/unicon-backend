export type GcraAdmissionFailureReason =
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'STATE_UNAVAILABLE'
  | 'RETRY_EXHAUSTED'
  | 'COMMIT_OUTCOME_UNKNOWN';

/** Safe diagnostics only: never retain a raw DB error, query, subject or key. */
export class GcraAdmissionInfrastructureError extends Error {
  constructor(readonly reason: GcraAdmissionFailureReason) {
    super('Authoritative GCRA admission could not be established.');
    this.name = GcraAdmissionInfrastructureError.name;
  }
}
