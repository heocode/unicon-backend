export class AuthenticationChallengeEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = AuthenticationChallengeEncryptionConfigurationError.name;
  }
}
