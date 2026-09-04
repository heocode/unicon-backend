export class CorruptedAuthenticationChallengeProofError extends Error {
  constructor() {
    super('Encrypted authentication challenge proof is corrupted.');
    this.name = CorruptedAuthenticationChallengeProofError.name;
  }
}
