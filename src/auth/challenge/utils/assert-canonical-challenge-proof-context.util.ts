import { AuthenticationChallengePurpose } from '../../../generated/prisma/enums';

import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';

import type { ChallengeProofContext } from '../types/challenge-proof.type';

export function assertCanonicalChallengeProofContext(
  context: ChallengeProofContext,
): void {
  assertCanonicalUuid(context.challengeId);

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
