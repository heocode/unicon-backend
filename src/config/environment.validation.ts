import { parseAuthenticationChallengeKeyring } from './utils/parse-authentication-challenge-keyring.util';
import { AUTHENTICATION_MAGIC_LINK_PUBLIC_URL } from './constants/authentication-magic-link.constants';

const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CLIENT_URL',
  'PASSWORD_RESET_RATE_LIMIT_SECRET',
  'ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET',
  'AUTH_CHALLENGE_HMAC_KEYS',
  'AUTH_CHALLENGE_ENCRYPTION_KEYS',
  'AUTH_MAGIC_LINK_PUBLIC_URL',
] as const;

export function validateEnvironment(
  environment: Record<string, unknown>,
): Record<string, unknown> {
  const validatedEnvironment = { ...environment };

  for (const key of REQUIRED_ENVIRONMENT_VARIABLES) {
    validatedEnvironment[key] = getRequiredString(environment, key);
  }

  validateUrl(validatedEnvironment.DATABASE_URL, 'DATABASE_URL', [
    'postgres:',
    'postgresql:',
  ]);
  validateUrl(validatedEnvironment.CLIENT_URL, 'CLIENT_URL', [
    'http:',
    'https:',
  ]);
  assertCanonicalMagicLinkPublicUrl(
    validatedEnvironment.AUTH_MAGIC_LINK_PUBLIC_URL,
  );

  validatedEnvironment.JWT_ACCESS_TTL_SECONDS = parsePositiveInteger(
    environment.JWT_ACCESS_TTL_SECONDS,
    'JWT_ACCESS_TTL_SECONDS',
  );
  validatedEnvironment.SESSION_INACTIVITY_TTL_SECONDS = parsePositiveInteger(
    environment.SESSION_INACTIVITY_TTL_SECONDS,
    'SESSION_INACTIVITY_TTL_SECONDS',
  );
  validatedEnvironment.SESSION_MANAGEMENT_COOLDOWN_SECONDS =
    parsePositiveInteger(
      environment.SESSION_MANAGEMENT_COOLDOWN_SECONDS,
      'SESSION_MANAGEMENT_COOLDOWN_SECONDS',
    );
  validatedEnvironment.SESSION_ACTIVE_LIMIT = parsePositiveInteger(
    environment.SESSION_ACTIVE_LIMIT,
    'SESSION_ACTIVE_LIMIT',
  );
  validatedEnvironment.SECURITY_EVENT_RETENTION_SECONDS = parsePositiveInteger(
    environment.SECURITY_EVENT_RETENTION_SECONDS,
    'SECURITY_EVENT_RETENTION_SECONDS',
  );
  validatedEnvironment.NOTIFICATION_DELIVERY_RETENTION_SECONDS =
    parsePositiveInteger(
      environment.NOTIFICATION_DELIVERY_RETENTION_SECONDS,
      'NOTIFICATION_DELIVERY_RETENTION_SECONDS',
    );
  validatedEnvironment.RISK_LOGIN_FAILURE_WINDOW_SECONDS = parsePositiveInteger(
    environment.RISK_LOGIN_FAILURE_WINDOW_SECONDS,
    'RISK_LOGIN_FAILURE_WINDOW_SECONDS',
  );
  validatedEnvironment.RISK_LOGIN_FAILURE_THRESHOLD = parsePositiveInteger(
    environment.RISK_LOGIN_FAILURE_THRESHOLD,
    'RISK_LOGIN_FAILURE_THRESHOLD',
  );
  validatedEnvironment.RISK_NEW_SESSION_WINDOW_SECONDS = parsePositiveInteger(
    environment.RISK_NEW_SESSION_WINDOW_SECONDS,
    'RISK_NEW_SESSION_WINDOW_SECONDS',
  );
  validatedEnvironment.RISK_NEW_SESSION_THRESHOLD = parsePositiveInteger(
    environment.RISK_NEW_SESSION_THRESHOLD,
    'RISK_NEW_SESSION_THRESHOLD',
  );
  validatedEnvironment.PASSWORD_RESET_TOKEN_TTL_SECONDS = parsePositiveInteger(
    environment.PASSWORD_RESET_TOKEN_TTL_SECONDS,
    'PASSWORD_RESET_TOKEN_TTL_SECONDS',
  );
  validatedEnvironment.PASSWORD_RESET_REQUEST_WINDOW_SECONDS =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_WINDOW_SECONDS,
      'PASSWORD_RESET_REQUEST_WINDOW_SECONDS',
    );
  validatedEnvironment.PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL,
      'PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL',
    );
  validatedEnvironment.PASSWORD_RESET_REQUEST_LIMIT_PER_IP =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_LIMIT_PER_IP,
      'PASSWORD_RESET_REQUEST_LIMIT_PER_IP',
    );
  validatedEnvironment.ACCOUNT_DELETION_GRACE_PERIOD_SECONDS =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_GRACE_PERIOD_SECONDS,
      'ACCOUNT_DELETION_GRACE_PERIOD_SECONDS',
    );
  validatedEnvironment.ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE,
      'ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE',
    );
  validatedEnvironment.ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS,
      'ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS',
    );
  validatedEnvironment.ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS,
      'ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS',
    );
  validatedEnvironment.ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL,
      'ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL',
    );
  validatedEnvironment.ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP =
    parsePositiveInteger(
      environment.ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP,
      'ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP',
    );

  const challengeTtlSeconds = parsePositiveInteger(
    environment.AUTH_CHALLENGE_TTL_SECONDS,
    'AUTH_CHALLENGE_TTL_SECONDS',
  );
  validatedEnvironment.AUTH_CHALLENGE_MAX_ATTEMPTS = parsePositiveInteger(
    environment.AUTH_CHALLENGE_MAX_ATTEMPTS,
    'AUTH_CHALLENGE_MAX_ATTEMPTS',
  );
  const challengeRetentionSeconds = parsePositiveInteger(
    environment.AUTH_CHALLENGE_RETENTION_SECONDS,
    'AUTH_CHALLENGE_RETENTION_SECONDS',
  );

  if (challengeRetentionSeconds < challengeTtlSeconds) {
    throw new Error(
      'Environment variable AUTH_CHALLENGE_RETENTION_SECONDS must be greater than or equal to AUTH_CHALLENGE_TTL_SECONDS.',
    );
  }

  validatedEnvironment.AUTH_CHALLENGE_TTL_SECONDS = challengeTtlSeconds;
  validatedEnvironment.AUTH_CHALLENGE_RETENTION_SECONDS =
    challengeRetentionSeconds;
  validatedEnvironment.AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS =
    parsePositiveInteger(
      environment.AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS,
      'AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS',
    );
  validatedEnvironment.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE =
    parsePositiveIntegerAtMost(
      environment.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE,
      'AUTH_CHALLENGE_CLEANUP_BATCH_SIZE',
      1_000,
    );
  validatedEnvironment.AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN =
    parsePositiveIntegerAtMost(
      environment.AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN,
      'AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN',
      100,
    );

  const deliveryMaxProcessingAttempts = parsePositiveInteger(
    environment.AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS,
    'AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS',
  );
  const deliveryRetryBackoffSeconds = parsePositiveIntegerSequence(
    environment.AUTH_DELIVERY_RETRY_BACKOFF_SECONDS,
    'AUTH_DELIVERY_RETRY_BACKOFF_SECONDS',
  );

  if (
    deliveryRetryBackoffSeconds.length !==
    deliveryMaxProcessingAttempts - 1
  ) {
    throw new Error(
      'Environment variable AUTH_DELIVERY_RETRY_BACKOFF_SECONDS must contain exactly one delay for each retryable processing attempt.',
    );
  }

  const deliveryHttpTimeoutSeconds = parsePositiveInteger(
    environment.AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS,
    'AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS',
  );
  const deliveryProcessingLeaseSeconds = parsePositiveInteger(
    environment.AUTH_DELIVERY_PROCESSING_LEASE_SECONDS,
    'AUTH_DELIVERY_PROCESSING_LEASE_SECONDS',
  );
  const deliveryMinValidityRemainingSeconds = parsePositiveInteger(
    environment.AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS,
    'AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS',
  );
  const deliveryProviderIdempotencyWindowSeconds = parsePositiveInteger(
    environment.AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS,
    'AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS',
  );

  if (deliveryProcessingLeaseSeconds <= deliveryHttpTimeoutSeconds) {
    throw new Error(
      'Environment variable AUTH_DELIVERY_PROCESSING_LEASE_SECONDS must be greater than AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS.',
    );
  }

  if (deliveryMinValidityRemainingSeconds >= challengeTtlSeconds) {
    throw new Error(
      'Environment variable AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS must be less than AUTH_CHALLENGE_TTL_SECONDS.',
    );
  }

  if (deliveryProviderIdempotencyWindowSeconds < challengeTtlSeconds) {
    throw new Error(
      'Environment variable AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS must be greater than or equal to AUTH_CHALLENGE_TTL_SECONDS.',
    );
  }

  validatedEnvironment.AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS =
    deliveryMaxProcessingAttempts;
  validatedEnvironment.AUTH_DELIVERY_RETRY_BACKOFF_SECONDS =
    deliveryRetryBackoffSeconds;
  validatedEnvironment.AUTH_DELIVERY_RETRY_JITTER_PERCENT =
    parsePositiveIntegerAtMost(
      environment.AUTH_DELIVERY_RETRY_JITTER_PERCENT,
      'AUTH_DELIVERY_RETRY_JITTER_PERCENT',
      99,
    );
  validatedEnvironment.AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS =
    deliveryHttpTimeoutSeconds;
  validatedEnvironment.AUTH_DELIVERY_PROCESSING_LEASE_SECONDS =
    deliveryProcessingLeaseSeconds;
  validatedEnvironment.AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS =
    deliveryMinValidityRemainingSeconds;
  validatedEnvironment.AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS =
    deliveryProviderIdempotencyWindowSeconds;

  validatedEnvironment.AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION =
    parsePositiveInteger(
      environment.AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION,
      'AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION',
    );
  validatedEnvironment.AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION =
    parsePositiveInteger(
      environment.AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION,
      'AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION',
    );

  const hmacKeyring = parseAuthenticationChallengeKeyring(
    validatedEnvironment.AUTH_CHALLENGE_HMAC_KEYS,
    'AUTH_CHALLENGE_HMAC_KEYS',
    (key) => key.length >= 32,
  );
  const encryptionKeyring = parseAuthenticationChallengeKeyring(
    validatedEnvironment.AUTH_CHALLENGE_ENCRYPTION_KEYS,
    'AUTH_CHALLENGE_ENCRYPTION_KEYS',
    (key) => key.length === 32,
  );

  assertActiveKeyExists(
    hmacKeyring,
    validatedEnvironment.AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION,
    'AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION',
  );
  assertActiveKeyExists(
    encryptionKeyring,
    validatedEnvironment.AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION,
    'AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION',
  );
  assertKeyringsAreIndependent(hmacKeyring, encryptionKeyring);

  validatedEnvironment.AUTH_CHALLENGE_HMAC_KEYS = hmacKeyring;
  validatedEnvironment.AUTH_CHALLENGE_ENCRYPTION_KEYS = encryptionKeyring;

  validatedEnvironment.PORT = parsePort(environment.PORT);
  validatedEnvironment.GEOIP_ENABLED = parseBoolean(
    environment.GEOIP_ENABLED,
    'GEOIP_ENABLED',
    false,
  );
  validatedEnvironment.GEOIP_DATABASE_PATH = getRequiredString(
    environment,
    'GEOIP_DATABASE_PATH',
  );
  validatedEnvironment.GEOIP_RELOAD_INTERVAL_SECONDS = parsePositiveInteger(
    environment.GEOIP_RELOAD_INTERVAL_SECONDS,
    'GEOIP_RELOAD_INTERVAL_SECONDS',
  );

  return validatedEnvironment;
}

function assertActiveKeyExists(
  keyring: ReadonlyMap<number, Buffer>,
  activeVersion: unknown,
  environmentKey: string,
): void {
  if (typeof activeVersion !== 'number' || !keyring.has(activeVersion)) {
    throw new Error(
      `Environment variable ${environmentKey} must reference a key present in its keyring.`,
    );
  }
}

function assertKeyringsAreIndependent(
  hmacKeyring: ReadonlyMap<number, Buffer>,
  encryptionKeyring: ReadonlyMap<number, Buffer>,
): void {
  for (const hmacKey of hmacKeyring.values()) {
    for (const encryptionKey of encryptionKeyring.values()) {
      if (hmacKey.equals(encryptionKey)) {
        throw new Error(
          'Authentication challenge HMAC and encryption keys must be independent.',
        );
      }
    }
  }
}

function parseBoolean(
  value: unknown,
  key: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  throw new Error(`Environment variable ${key} must be true or false.`);
}

function getRequiredString(
  environment: Record<string, unknown>,
  key: string,
): string {
  const value = environment[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Environment variable ${key} is required.`);
  }

  return value.trim();
}

function validateUrl(value: unknown, key: string, protocols: string[]): void {
  if (typeof value !== 'string') {
    throw new Error(`Environment variable ${key} must be a valid URL.`);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Environment variable ${key} must be a valid URL.`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(
      `Environment variable ${key} must use one of these protocols: ${protocols.join(', ')}.`,
    );
  }
}

function assertCanonicalMagicLinkPublicUrl(value: unknown): void {
  if (value !== AUTHENTICATION_MAGIC_LINK_PUBLIC_URL) {
    throw new Error(
      'Environment variable AUTH_MAGIC_LINK_PUBLIC_URL must equal the canonical authentication intent URL.',
    );
  }
}

function parsePort(value: unknown): number {
  if (value === undefined || value === '') {
    return 3000;
  }

  const port = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Environment variable PORT must be an integer between 1 and 65535.',
    );
  }

  return port;
}

function parsePositiveInteger(value: unknown, key: string): number {
  const parsedValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer.`);
  }

  return parsedValue;
}

function parsePositiveIntegerAtMost(
  value: unknown,
  key: string,
  maximum: number,
): number {
  const parsedValue = parsePositiveInteger(value, key);

  if (parsedValue > maximum) {
    throw new Error(
      `Environment variable ${key} must be less than or equal to ${maximum}.`,
    );
  }

  return parsedValue;
}

function parsePositiveIntegerSequence(value: unknown, key: string): number[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `Environment variable ${key} must be a comma-separated sequence of positive integers.`,
    );
  }

  const sequence = value.split(',').map((part) => Number(part.trim()));

  if (
    sequence.some((entry) => !Number.isInteger(entry) || entry <= 0) ||
    sequence.some((entry, index) => index > 0 && entry <= sequence[index - 1])
  ) {
    throw new Error(
      `Environment variable ${key} must be a strictly increasing comma-separated sequence of positive integers.`,
    );
  }

  return sequence;
}
