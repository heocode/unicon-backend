import { validateEnvironment } from './environment.validation';

const hmacKey = Buffer.alloc(32, 1).toString('base64');
const rotatedHmacKey = Buffer.alloc(32, 2).toString('base64');
const encryptionKey = Buffer.alloc(32, 3).toString('base64');

const validEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/unicon',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_SECRET: 'refresh-secret',
  SESSION_INACTIVITY_TTL_SECONDS: '31536000',
  SESSION_MANAGEMENT_COOLDOWN_SECONDS: '86400',
  SESSION_ACTIVE_LIMIT: '10',
  SECURITY_EVENT_RETENTION_SECONDS: '15552000',
  NOTIFICATION_DELIVERY_RETENTION_SECONDS: '15552000',
  RISK_LOGIN_FAILURE_WINDOW_SECONDS: '900',
  RISK_LOGIN_FAILURE_THRESHOLD: '5',
  RISK_NEW_SESSION_WINDOW_SECONDS: '3600',
  RISK_NEW_SESSION_THRESHOLD: '3',
  PASSWORD_RESET_TOKEN_TTL_SECONDS: '1800',
  PASSWORD_RESET_REQUEST_WINDOW_SECONDS: '900',
  PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL: '3',
  PASSWORD_RESET_REQUEST_LIMIT_PER_IP: '10',
  PASSWORD_RESET_RATE_LIMIT_SECRET: 'recovery-rate-secret',
  ACCOUNT_DELETION_GRACE_PERIOD_SECONDS: '2592000',
  ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE: '100',
  ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS: '300',
  ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS: '900',
  ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL: '5',
  ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP: '20',
  ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET: 'deletion-cancel-rate-secret',
  AUTH_CHALLENGE_TTL_SECONDS: '600',
  AUTH_CHALLENGE_MAX_ATTEMPTS: '5',
  AUTH_CHALLENGE_RETENTION_SECONDS: '86400',
  AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS: '60',
  AUTH_CHALLENGE_CLEANUP_BATCH_SIZE: '100',
  AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN: '10',
  AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS: '5',
  AUTH_DELIVERY_RETRY_BACKOFF_SECONDS: '5,15,30,60',
  AUTH_DELIVERY_RETRY_JITTER_PERCENT: '20',
  AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS: '10',
  AUTH_DELIVERY_PROCESSING_LEASE_SECONDS: '45',
  AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS: '120',
  AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS: '86400',
  AUTH_MAGIC_LINK_PUBLIC_URL: 'https://uniconnection.app/auth/verify',
  AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: '1',
  AUTH_CHALLENGE_HMAC_KEYS: `1:${hmacKey}`,
  AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
  AUTH_CHALLENGE_ENCRYPTION_KEYS: `1:${encryptionKey}`,
  RESEND_API_KEY: 'resend-api-key',
  MAIL_FROM: 'noreply@unicon.local',
  CLIENT_URL: 'http://localhost:3001',
  GEOIP_ENABLED: 'false',
  GEOIP_DATABASE_PATH: 'data/geoip/GeoLite2-City.mmdb',
  GEOIP_RELOAD_INTERVAL_SECONDS: '60',
};

describe('validateEnvironment', () => {
  it('parses PORT and preserves validated configuration', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      PORT: '4000',
    });

    expect(environment.PORT).toBe(4000);
    expect(environment.DATABASE_URL).toBe(validEnvironment.DATABASE_URL);
  });

  it('uses port 3000 by default', () => {
    const environment = validateEnvironment(validEnvironment);

    expect(environment.PORT).toBe(3000);
  });

  it('rejects a missing required variable', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: undefined,
      }),
    ).toThrow('Environment variable DATABASE_URL is required.');
  });

  it('rejects a non-positive token TTL', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_ACCESS_TTL_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable JWT_ACCESS_TTL_SECONDS must be a positive integer.',
    );
  });

  it('rejects a non-positive session revoke cooldown', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_MANAGEMENT_COOLDOWN_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable SESSION_MANAGEMENT_COOLDOWN_SECONDS must be a positive integer.',
    );
  });

  it('rejects a non-positive active session limit', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_ACTIVE_LIMIT: '0',
      }),
    ).toThrow(
      'Environment variable SESSION_ACTIVE_LIMIT must be a positive integer.',
    );
  });

  it('rejects a non-positive security-event retention', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SECURITY_EVENT_RETENTION_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable SECURITY_EVENT_RETENTION_SECONDS must be a positive integer.',
    );
  });

  it('rejects a non-positive notification-delivery retention', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NOTIFICATION_DELIVERY_RETENTION_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable NOTIFICATION_DELIVERY_RETENTION_SECONDS must be a positive integer.',
    );
  });

  it.each([
    'RISK_LOGIN_FAILURE_WINDOW_SECONDS',
    'RISK_LOGIN_FAILURE_THRESHOLD',
    'RISK_NEW_SESSION_WINDOW_SECONDS',
    'RISK_NEW_SESSION_THRESHOLD',
  ])('rejects a non-positive %s value', (key) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        [key]: '0',
      }),
    ).toThrow(`Environment variable ${key} must be a positive integer.`);
  });

  it('rejects a fractional challenge setting', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_MAX_ATTEMPTS: '5.5',
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_MAX_ATTEMPTS must be a positive integer.',
    );
  });

  it.each([
    'AUTH_CHALLENGE_TTL_SECONDS',
    'AUTH_CHALLENGE_MAX_ATTEMPTS',
    'AUTH_CHALLENGE_RETENTION_SECONDS',
    'AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS',
    'AUTH_CHALLENGE_CLEANUP_BATCH_SIZE',
    'AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN',
    'AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION',
    'AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION',
  ])('rejects a non-positive %s value', (key) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        [key]: '0',
      }),
    ).toThrow(`Environment variable ${key} must be a positive integer.`);
  });

  it('rejects challenge retention shorter than its lifetime', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_RETENTION_SECONDS: '599',
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_RETENTION_SECONDS must be greater than or equal to AUTH_CHALLENGE_TTL_SECONDS.',
    );
  });

  it('parses the authentication delivery retry policy', () => {
    const environment = validateEnvironment(validEnvironment);

    expect(environment.AUTH_DELIVERY_RETRY_BACKOFF_SECONDS).toEqual([
      5, 15, 30, 60,
    ]);
  });

  it.each([
    ['5,15,30', 'the wrong number of delays'],
    ['5,15,15,60', 'a non-increasing delay'],
    ['5,invalid,30,60', 'a non-integer delay'],
  ])('rejects delivery backoff with %s', (value) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_DELIVERY_RETRY_BACKOFF_SECONDS: value,
      }),
    ).toThrow('Environment variable AUTH_DELIVERY_RETRY_BACKOFF_SECONDS');
  });

  it('rejects a processing lease that does not exceed the HTTP timeout', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_DELIVERY_PROCESSING_LEASE_SECONDS: '10',
      }),
    ).toThrow(
      'Environment variable AUTH_DELIVERY_PROCESSING_LEASE_SECONDS must be greater than AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS.',
    );
  });

  it.each([
    'https://uniconnection.app/auth/verify/',
    'http://uniconnection.app/auth/verify',
    'https://www.uniconnection.app/auth/verify',
    'https://uniconnection.app/auth/verify?source=app',
    'https://uniconnection.app/auth/verify#auth',
  ])('rejects non-canonical magic-link public URL %s', (value) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_MAGIC_LINK_PUBLIC_URL: value,
      }),
    ).toThrow(
      'Environment variable AUTH_MAGIC_LINK_PUBLIC_URL must equal the canonical authentication intent URL.',
    );
  });

  it('rejects a delivery validity floor at least as long as the challenge TTL', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS: '600',
      }),
    ).toThrow(
      'Environment variable AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS must be less than AUTH_CHALLENGE_TTL_SECONDS.',
    );
  });

  it.each([
    ['AUTH_CHALLENGE_CLEANUP_BATCH_SIZE', '1001', 1_000],
    ['AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN', '101', 100],
  ])('rejects %s above its operational maximum', (key, value, maximum) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        [key]: value,
      }),
    ).toThrow(
      `Environment variable ${key} must be less than or equal to ${maximum}.`,
    );
  });

  it('parses versioned challenge keyrings', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: '2',
      AUTH_CHALLENGE_HMAC_KEYS: `1:${hmacKey},2:${rotatedHmacKey}`,
    });

    expect(environment.AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION).toBe(2);
    expect(environment.AUTH_CHALLENGE_HMAC_KEYS).toEqual(
      new Map([
        [1, Buffer.alloc(32, 1)],
        [2, Buffer.alloc(32, 2)],
      ]),
    );
  });

  it.each([
    ['an entry without a version', 'invalid'],
    ['a zero version', `0:${hmacKey}`],
    ['duplicate versions', `1:${hmacKey},1:${rotatedHmacKey}`],
    ['non-canonical base64', `1:${hmacKey.replace(/=$/, '')}`],
    ['a short key', `1:${Buffer.alloc(31, 1).toString('base64')}`],
  ])('rejects an HMAC keyring with %s', (_case, value) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_HMAC_KEYS: value,
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_HMAC_KEYS must be a valid versioned base64 keyring.',
    );
  });

  it('rejects an encryption key that is not exactly 32 bytes', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: `1:${Buffer.alloc(33, 3).toString('base64')}`,
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_ENCRYPTION_KEYS must be a valid versioned base64 keyring.',
    );
  });

  it('rejects an active version absent from its keyring', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: '2',
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION must reference a key present in its keyring.',
    );
  });

  it('rejects reuse of challenge keys across cryptographic purposes', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: `1:${hmacKey}`,
      }),
    ).toThrow(
      'Authentication challenge HMAC and encryption keys must be independent.',
    );
  });

  it('does not expose challenge key material in validation errors', () => {
    const secret = 'this-is-sensitive';

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_HMAC_KEYS: `1:${secret}`,
      }),
    ).toThrow(
      'Environment variable AUTH_CHALLENGE_HMAC_KEYS must be a valid versioned base64 keyring.',
    );

    try {
      validateEnvironment({
        ...validEnvironment,
        AUTH_CHALLENGE_HMAC_KEYS: `1:${secret}`,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it.each([
    'ACCOUNT_DELETION_GRACE_PERIOD_SECONDS',
    'ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE',
    'ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS',
    'ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS',
    'ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL',
    'ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP',
  ])('rejects a non-positive %s value', (key) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        [key]: '0',
      }),
    ).toThrow(`Environment variable ${key} must be a positive integer.`);
  });

  it('parses the GeoIP enabled flag', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      GEOIP_ENABLED: 'true',
    });

    expect(environment.GEOIP_ENABLED).toBe(true);
  });

  it('rejects a non-positive GeoIP reload interval', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        GEOIP_RELOAD_INTERVAL_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable GEOIP_RELOAD_INTERVAL_SECONDS must be a positive integer.',
    );
  });
});
