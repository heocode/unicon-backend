export class AuthenticationChallengeTransitionConflictError extends Error {
  constructor() {
    super('Authentication challenge state transition failed.');
    this.name = AuthenticationChallengeTransitionConflictError.name;
  }
}
