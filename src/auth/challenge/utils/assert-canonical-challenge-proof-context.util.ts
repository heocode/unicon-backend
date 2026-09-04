import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import type { ChallengeProofContext } from '../types/challenge-proof.type';

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertCanonicalChallengeProofContext(
  context: ChallengeProofContext,
): void {
  if (!CANONICAL_UUID_PATTERN.test(context.challengeId)) {
    throw new TypeError('Challenge ID must use its canonical representation.');
  }

  if (
    context.normalizedIdentity.length === 0 ||
    context.normalizedIdentity !== context.normalizedIdentity.trim() ||
    context.normalizedIdentity !== context.normalizedIdentity.toLowerCase()
  ) {
    throw new TypeError('Challenge identity must already be normalized.');
  }

  if (
    !Object.values(AuthenticationChallengePurpose).includes(context.purpose)
  ) {
    throw new TypeError('Challenge purpose is invalid.');
  }
}
