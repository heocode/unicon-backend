import { ConfigService } from '@nestjs/config';

import { AuthenticationRateLimitConfigService } from '../auth/rate-limit/services/authentication-rate-limit-config.service';
import { HttpRequestRateLimitConfigService } from '../http-rate-limit/services/http-request-rate-limit-config.service';
import { RateLimitBucketKeyService } from '../rate-limit/services/rate-limit-bucket-key.service';
import { AUTHENTICATION_RATE_LIMIT_POLICIES } from '../auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { validateEnvironment } from './environment.validation';

const hmacKey = Buffer.alloc(32, 1).toString('base64');
const rotatedHmacKey = Buffer.alloc(32, 2).toString('base64');
const encryptionKey = Buffer.alloc(32, 3).toString('base64');
const rateLimitKey = Buffer.alloc(32, 4).toString('base64');
const rotatedRateLimitKey = Buffer.alloc(32, 5).toString('base64');

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
  AUTH_DELIVERY_WORKER_INTERVAL_SECONDS: '1',
  AUTH_DELIVERY_WORKER_CONCURRENCY: '4',
  AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE: '20',
  AUTH_DELIVERY_WORKER_EXHAUSTED_LEASE_BATCH_SIZE: '100',
  AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS: '60',
  AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS: '60',
  AUTH_DELIVERY_IDENTITY_BURST: '10',
  AUTH_DELIVERY_IDENTITY_RATE: '7',
  AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS: '3600',
  AUTH_DELIVERY_IP_BURST: '120',
  AUTH_DELIVERY_IP_RATE: '240',
  AUTH_DELIVERY_IP_PERIOD_SECONDS: '3600',
  AUTH_VERIFICATION_IDENTITY_SHORT_BURST: '6',
  AUTH_VERIFICATION_IDENTITY_SHORT_RATE: '6',
  AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS: '60',
  AUTH_VERIFICATION_IP_SHORT_BURST: '72',
  AUTH_VERIFICATION_IP_SHORT_RATE: '72',
  AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS: '60',
  AUTH_VERIFICATION_IDENTITY_LONG_BURST: '8',
  AUTH_VERIFICATION_IDENTITY_LONG_RATE: '12',
  AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS: '3600',
  AUTH_VERIFICATION_IP_LONG_BURST: '360',
  AUTH_VERIFICATION_IP_LONG_RATE: '360',
  AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS: '3600',
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST: '200',
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE: '600',
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS: '60',
  AUTH_MAGIC_LINK_PUBLIC_URL: 'https://uniconnection.app/auth/verify',
  AUTH_EMAIL_FROM: 'Unicon <noreply@uniconnection.app>',
  AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: '1',
  AUTH_CHALLENGE_HMAC_KEYS: `1:${hmacKey}`,
  AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: '1',
  AUTH_CHALLENGE_ENCRYPTION_KEYS: `1:${encryptionKey}`,
  RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: '1',
  RATE_LIMIT_HMAC_KEYS: `1:${rateLimitKey}`,
  RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: '3',
  RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: '5',
  RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: '2',
  RESEND_API_KEY: 'resend-api-key',
  MAIL_FROM: 'noreply@unicon.local',
  CLIENT_URL: 'http://localhost:3001',
  GEOIP_ENABLED: 'false',
  GEOIP_DATABASE_PATH: 'data/geoip/GeoLite2-City.mmdb',
  GEOIP_RELOAD_INTERVAL_SECONDS: '60',
};

const rateLimitEnvironmentKeys = [
  'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
  'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
  'AUTH_DELIVERY_IDENTITY_BURST',
  'AUTH_DELIVERY_IDENTITY_RATE',
  'AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS',
  'AUTH_DELIVERY_IP_BURST',
  'AUTH_DELIVERY_IP_RATE',
  'AUTH_DELIVERY_IP_PERIOD_SECONDS',
  'AUTH_VERIFICATION_IDENTITY_SHORT_BURST',
  'AUTH_VERIFICATION_IDENTITY_SHORT_RATE',
  'AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS',
  'AUTH_VERIFICATION_IP_SHORT_BURST',
  'AUTH_VERIFICATION_IP_SHORT_RATE',
  'AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS',
  'AUTH_VERIFICATION_IDENTITY_LONG_BURST',
  'AUTH_VERIFICATION_IDENTITY_LONG_RATE',
  'AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS',
  'AUTH_VERIFICATION_IP_LONG_BURST',
  'AUTH_VERIFICATION_IP_LONG_RATE',
  'AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS',
  'HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST',
  'HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE',
  'HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS',
] as const;

describe('validateEnvironment', () => {
  it('parses GCRA transaction bounds', () => {
    const environment = validateEnvironment(validEnvironment);
    expect(environment.RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS).toBe(3);
    expect(environment.RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS).toBe(5);
    expect(environment.RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS).toBe(2);
  });

  describe.each([
    ['RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS', 5],
    ['RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS', 60],
    ['RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS', 60],
  ] as const)('%s', (key, maximum) => {
    it.each([undefined, '0', '-1', '1.5', '9007199254740992', true])(
      'rejects invalid transaction setting %s',
      (value) => {
        expect(() =>
          validateEnvironment({ ...validEnvironment, [key]: value }),
        ).toThrow(
          `Environment variable ${key} must be a positive safe integer in decimal notation.`,
        );
      },
    );
    it('enforces its operational upper bound', () => {
      expect(() =>
        validateEnvironment({
          ...validEnvironment,
          [key]: String(maximum + 1),
        }),
      ).toThrow(
        `Environment variable ${key} must be less than or equal to ${maximum}.`,
      );
      expect(
        validateEnvironment({ ...validEnvironment, [key]: String(maximum) })[
          key
        ],
      ).toBe(maximum);
    });
  });
  it('parses an independent rate-limit keyring and derives keys through the real configuration boundary', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: '2',
      RATE_LIMIT_HMAC_KEYS: `2:${rotatedRateLimitKey},1:${rateLimitKey}`,
    });
    const config = new ConfigService(environment);
    config.skipProcessEnv = true;
    const service = new RateLimitBucketKeyService(config);

    expect(environment.RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION).toBe(2);
    expect(environment.RATE_LIMIT_HMAC_KEYS).toEqual(
      new Map([
        [2, Buffer.alloc(32, 5)],
        [1, Buffer.alloc(32, 4)],
      ]),
    );
    expect(
      service.deriveKeys(
        AUTHENTICATION_RATE_LIMIT_POLICIES.deliveryIdentity,
        'student@example.edu',
      ).buckets,
    ).toEqual([
      {
        keyVersion: 1,
        key: 'rl:v1:k1:a4b36988e7ca2b622826d65d229da6c3ef93a02b1b4794ec038d55548be8f128',
      },
      {
        keyVersion: 2,
        key: 'rl:v1:k2:d349c30396be455436ed722e41c07f6dc6e77c6165ef40bb4c8902651457bf7c',
      },
    ]);
  });

  it.each([
    undefined,
    '',
    'invalid',
    `0:${rateLimitKey}`,
    `01:${rateLimitKey}`,
    `9007199254740992:${rateLimitKey}`,
    `1:${rateLimitKey},1:${rotatedRateLimitKey}`,
    `1:${rateLimitKey.replace(/=$/, '')}`,
    `1:${Buffer.alloc(31, 4).toString('base64')}`,
    `1:${Buffer.alloc(33, 4).toString('base64')}`,
  ])(
    'rejects missing or malformed rate-limit key material without echoing it',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnvironment,
          RATE_LIMIT_HMAC_KEYS: value,
        }),
      ).toThrow('Environment variable RATE_LIMIT_HMAC_KEYS');
    },
  );

  it.each([undefined, '0', '-1', '1.5', '9007199254740992', true])(
    'rejects invalid rate-limit active version %s',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnvironment,
          RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: value,
        }),
      ).toThrow(
        'Environment variable RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION must be a positive safe integer in decimal notation.',
      );
    },
  );

  it('rejects an active rate-limit version absent from the keyring', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: '2',
      }),
    ).toThrow(
      'Environment variable RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION must reference a key present in its keyring.',
    );
  });

  it('rejects relabeling the same rate-limit key material as a new version', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        RATE_LIMIT_HMAC_KEYS: `1:${rateLimitKey},2:${rateLimitKey}`,
      }),
    ).toThrow('Rate-limit key versions must use distinct key material.');
  });

  it.each([hmacKey, rotatedHmacKey, encryptionKey])(
    'rejects reuse of active or historical challenge keys in any rate-limit version',
    (value) => {
      expect(() =>
        validateEnvironment({
          ...validEnvironment,
          AUTH_CHALLENGE_HMAC_KEYS: `1:${hmacKey},2:${rotatedHmacKey}`,
          RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: '2',
          RATE_LIMIT_HMAC_KEYS: `1:${value},2:${rateLimitKey}`,
        }),
      ).toThrow(
        'Rate-limit HMAC keys must be independent from challenge keys, JWT secrets, and legacy rate-limit secrets.',
      );
    },
  );

  it.each([
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'PASSWORD_RESET_RATE_LIMIT_SECRET',
    'ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET',
  ])(
    'rejects reuse of %s as raw bytes or copied base64 key material',
    (key) => {
      const keyBytes = Buffer.from('x'.repeat(32), 'utf8');
      for (const secret of [
        keyBytes.toString('utf8'),
        keyBytes.toString('base64'),
      ]) {
        expect(() =>
          validateEnvironment({
            ...validEnvironment,
            [key]: secret,
            RATE_LIMIT_HMAC_KEYS: `1:${keyBytes.toString('base64')}`,
          }),
        ).toThrow(
          'Rate-limit HMAC keys must be independent from challenge keys, JWT secrets, and legacy rate-limit secrets.',
        );
      }
    },
  );

  it('keeps invalid rate-limit key material out of diagnostic messages', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        RATE_LIMIT_HMAC_KEYS: '1:sensitive-invalid-key-material',
      }),
    ).toThrow(
      new Error(
        'Environment variable RATE_LIMIT_HMAC_KEYS must be a valid versioned base64 keyring.',
      ),
    );
  });

  it('parses all Stage 4 policy settings without changing the supplied environment', () => {
    const environment = validateEnvironment(validEnvironment);

    for (const key of rateLimitEnvironmentKeys) {
      expect(environment[key]).toBe(Number(validEnvironment[key]));
      expect(typeof validEnvironment[key]).toBe('string');
    }
  });

  it('provides validated snapshots to both domain and HTTP policy configuration', () => {
    const config = new ConfigService(validateEnvironment(validEnvironment));
    config.skipProcessEnv = true;
    const auth = new AuthenticationRateLimitConfigService(config);
    const http = new HttpRequestRateLimitConfigService(config);

    expect(auth.challengeDeliveryCooldownSeconds).toBe(60);
    expect(auth.identityDeliveryCooldownSeconds).toBe(60);
    expect(auth.deliveryIdentity).toEqual({
      burst: 10,
      rate: 7,
      periodSeconds: 3600,
    });
    expect(auth.deliveryIp).toEqual({
      burst: 120,
      rate: 240,
      periodSeconds: 3600,
    });
    expect(auth.verificationIdentityShortTerm).toEqual({
      burst: 6,
      rate: 6,
      periodSeconds: 60,
    });
    expect(auth.verificationIpShortTerm).toEqual({
      burst: 72,
      rate: 72,
      periodSeconds: 60,
    });
    expect(auth.verificationIdentityLongTerm).toEqual({
      burst: 8,
      rate: 12,
      periodSeconds: 3600,
    });
    expect(auth.verificationIpLongTerm).toEqual({
      burst: 360,
      rate: 360,
      periodSeconds: 3600,
    });
    expect(http.publicPasswordless).toEqual({
      burst: 200,
      rate: 600,
      periodSeconds: 60,
    });
  });

  describe.each(rateLimitEnvironmentKeys)('%s', (key) => {
    it.each([
      undefined,
      null,
      true,
      '0',
      '-1',
      '1.5',
      '9007199254740992',
      'not-a-number',
    ])('rejects invalid policy setting %s without echoing it', (value) => {
      expect(() =>
        validateEnvironment({ ...validEnvironment, [key]: value }),
      ).toThrow(
        `Environment variable ${key} must be a positive safe integer in decimal notation.`,
      );
    });
  });

  it.each([
    '',
    ' ',
    '01',
    '+1',
    '1e2',
    '0x10',
    '1\n',
    ' 1',
    '1 ',
    'Infinity',
    NaN,
    Infinity,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    [],
    {},
  ])('rejects non-decimal or invalid numeric policy input %s', (value) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_DELIVERY_IDENTITY_RATE: value,
      }),
    ).toThrow(
      'Environment variable AUTH_DELIVERY_IDENTITY_RATE must be a positive safe integer in decimal notation.',
    );
  });

  it.each([1, '1', Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)])(
    'accepts the positive safe integer boundary %s for policy inputs',
    (value) => {
      const environment = validateEnvironment({
        ...validEnvironment,
        AUTH_DELIVERY_IDENTITY_BURST: value,
        AUTH_DELIVERY_IDENTITY_RATE: value,
        AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS: value,
        AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS: value,
      });

      expect(environment.AUTH_DELIVERY_IDENTITY_BURST).toBe(Number(value));
      expect(environment.AUTH_DELIVERY_IDENTITY_RATE).toBe(Number(value));
      expect(environment.AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS).toBe(
        Number(value),
      );
      expect(environment.AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS).toBe(
        Number(value),
      );
    },
  );

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

  it.each([
    'noreply@uniconnection.app',
    'Unicon <no-reply@uniconnection.app>',
    'Unicon <noreply@example.com>',
  ])('rejects non-canonical authentication sender %s', (value) => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        AUTH_EMAIL_FROM: value,
      }),
    ).toThrow(
      'Environment variable AUTH_EMAIL_FROM must equal the canonical authentication sender.',
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
