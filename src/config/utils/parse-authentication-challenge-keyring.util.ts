import type { AuthenticationChallengeKeyring } from '../types/authentication-challenge-keyring.type';

const VERSIONED_KEY_PATTERN = /^([1-9]\d*):(.+)$/;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function parseAuthenticationChallengeKeyring(
  value: unknown,
  environmentKey: string,
  validateKeyLength: (key: Buffer) => boolean,
): AuthenticationChallengeKeyring {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throwInvalidKeyring(environmentKey);
  }

  const entries = value.trim().split(',');
  const keyring = new Map<number, Buffer>();

  for (const entry of entries) {
    const match = VERSIONED_KEY_PATTERN.exec(entry);

    if (!match) {
      throwInvalidKeyring(environmentKey);
    }

    const version = Number(match[1]);
    const encodedKey = match[2];

    if (
      !Number.isSafeInteger(version) ||
      keyring.has(version) ||
      !isCanonicalBase64(encodedKey)
    ) {
      throwInvalidKeyring(environmentKey);
    }

    const key = Buffer.from(encodedKey, 'base64');

    if (!validateKeyLength(key)) {
      throwInvalidKeyring(environmentKey);
    }

    keyring.set(version, key);
  }

  return keyring;
}

function isCanonicalBase64(value: string): boolean {
  return (
    CANONICAL_BASE64_PATTERN.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function throwInvalidKeyring(environmentKey: string): never {
  throw new Error(
    `Environment variable ${environmentKey} must be a valid versioned base64 keyring.`,
  );
}
