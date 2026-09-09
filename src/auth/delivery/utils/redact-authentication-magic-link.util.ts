import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';
import { AUTHENTICATION_MAGIC_LINK_PUBLIC_URL } from '../../../config/constants/authentication-magic-link.constants';

const REDACTED_AUTH_MAGIC_LINK = '[REDACTED_AUTH_MAGIC_LINK]';
const canonicalPublicUrl = new URL(AUTHENTICATION_MAGIC_LINK_PUBLIC_URL);

export function redactAuthenticationMagicLink(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    const challengeId = url.searchParams.get('challengeId');

    if (
      url.origin !== canonicalPublicUrl.origin ||
      url.pathname !== canonicalPublicUrl.pathname ||
      challengeId === null
    ) {
      return REDACTED_AUTH_MAGIC_LINK;
    }

    assertCanonicalUuid(challengeId);

    return `${url.origin}${url.pathname}?challengeId=${encodeURIComponent(challengeId)}&token=[REDACTED]`;
  } catch {
    return REDACTED_AUTH_MAGIC_LINK;
  }
}
