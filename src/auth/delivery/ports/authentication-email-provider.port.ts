import type {
  AuthenticationEmailProviderResult,
  AuthenticationEmailSubmission,
} from '../types/authentication-email-provider.type';

export abstract class AuthenticationEmailProviderPort {
  abstract submit(
    submission: AuthenticationEmailSubmission,
    beforeSubmission: () => Promise<boolean>,
  ): Promise<AuthenticationEmailProviderResult>;
}
