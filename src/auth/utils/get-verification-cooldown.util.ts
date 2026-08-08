import { VERIFICATION_EMAIL_COOLDOWN_SECONDS } from '../constants/email-verification.constants';

export function getVerificationCooldownSeconds(
  lastSentAt: Date | null,
): number {
  if (!lastSentAt) {
    return 0;
  }

  const elapsedMilliseconds = Date.now() - lastSentAt.getTime();

  const elapsedSeconds = Math.floor(elapsedMilliseconds / 1000);

  return Math.max(0, VERIFICATION_EMAIL_COOLDOWN_SECONDS - elapsedSeconds);
}
