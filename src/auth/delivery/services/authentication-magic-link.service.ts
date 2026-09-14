// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal utilities
import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';
import { AUTHENTICATION_MAGIC_LINK_PUBLIC_URL } from '../../../config/constants/authentication-magic-link.constants';
import { parseCanonicalMagicLinkToken } from '../../challenge/utils/parse-canonical-challenge-proof.util';

export type BuildAuthenticationMagicLinkInput = {
  challengeId: string;
  linkToken: string;
};

@Injectable()
export class AuthenticationMagicLinkService {
  private readonly publicUrl: string;

  constructor(configService: ConfigService) {
    this.publicUrl = configService.getOrThrow<string>(
      'AUTH_MAGIC_LINK_PUBLIC_URL',
    );

    if (this.publicUrl !== AUTHENTICATION_MAGIC_LINK_PUBLIC_URL) {
      throw new Error('Authentication magic-link configuration is invalid.');
    }
  }

  buildVerificationUrl(input: BuildAuthenticationMagicLinkInput): string {
    assertCanonicalUuid(input.challengeId);
    parseCanonicalMagicLinkToken(input.linkToken);

    const url = new URL(this.publicUrl);
    url.searchParams.append('challengeId', input.challengeId);
    url.searchParams.append('token', input.linkToken);

    return url.toString();
  }

  assertCanonicalVerificationUrl(value: string): void {
    try {
      const url = new URL(value);
      const challengeId = url.searchParams.get('challengeId');
      const linkToken = url.searchParams.get('token');

      if (
        challengeId === null ||
        linkToken === null ||
        [...url.searchParams].length !== 2 ||
        this.buildVerificationUrl({ challengeId, linkToken }) !== value
      ) {
        throw new Error();
      }
    } catch {
      throw new Error('Authentication magic-link URL is not canonical.');
    }
  }
}
