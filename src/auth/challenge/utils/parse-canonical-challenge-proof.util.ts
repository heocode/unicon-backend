import {
  MAGIC_LINK_SECRET_BYTES,
  MAGIC_LINK_TOKEN_LENGTH,
  OTP_LENGTH,
} from '../constants/challenge-proof.constants';

const OTP_PATTERN = new RegExp(`^[0-9]{${OTP_LENGTH}}$`);
const MAGIC_LINK_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${MAGIC_LINK_TOKEN_LENGTH}}$`,
);

export function parseCanonicalOtp(otp: string): Buffer {
  if (!OTP_PATTERN.test(otp)) {
    throw new TypeError('OTP must use its canonical representation.');
  }

  return Buffer.from(otp, 'ascii');
}

export function parseCanonicalMagicLinkToken(token: string): Buffer {
  if (!MAGIC_LINK_TOKEN_PATTERN.test(token)) {
    throw new TypeError(
      'Magic-link token must use its canonical representation.',
    );
  }

  const secret = Buffer.from(token, 'base64url');

  if (
    secret.length !== MAGIC_LINK_SECRET_BYTES ||
    secret.toString('base64url') !== token
  ) {
    throw new TypeError(
      'Magic-link token must use its canonical representation.',
    );
  }

  return secret;
}
