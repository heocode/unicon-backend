import { ConfigService } from '@nestjs/config';

import { AUTHENTICATION_RATE_LIMIT_POLICIES as authPolicies } from '../../auth/rate-limit/constants/authentication-rate-limit-policies.constants';
import { PUBLIC_PASSWORDLESS_REQUEST_POLICY as requestPolicy } from '../../http-rate-limit/constants/http-request-rate-limit-policies.constants';
import type { RateLimitBucketPolicy } from '../types/rate-limit-bucket-key.type';
import { RateLimitBucketKeyService } from './rate-limit-bucket-key.service';

const challengeId = '123e4567-e89b-42d3-a456-426614174000';

function createConfig(
  activeVersion = 1,
  keys = new Map([[1, Buffer.alloc(32, 4)]]),
): ConfigService {
  const config = new ConfigService({
    RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: activeVersion,
    RATE_LIMIT_HMAC_KEYS: keys,
  });
  config.skipProcessEnv = true;
  return config;
}

describe('RateLimitBucketKeyService', () => {
  // Independently generated with Python hmac/sha256 + struct.pack('>I', byteLength).
  it.each([
    [
      authPolicies.deliveryIdentity,
      'student@example.edu',
      'rl:v1:k1:a4b36988e7ca2b622826d65d229da6c3ef93a02b1b4794ec038d55548be8f128',
      'rl:v1:k2:d349c30396be455436ed722e41c07f6dc6e77c6165ef40bb4c8902651457bf7c',
    ],
    [
      requestPolicy,
      '192.0.2.1',
      'rl:v1:k1:60b0603906be5b35031ca0c4727168a7a8f003410c1cdc5897be2d3a03069bcb',
      'rl:v1:k2:c812c9863b1ee79a6fe5a623e6f685229a191fea7205c80fa48efdfbb3658a84',
    ],
    [
      authPolicies.challengeDeliveryCooldown,
      challengeId,
      'rl:v1:k1:b89b897874617c65c7404873891e30fda100fff4106e62438eb5d07341ed3b36',
      'rl:v1:k2:614271febbf11149978664cfb99f29292c900382d66490b0c80723798d774bfd',
    ],
    [
      authPolicies.deliveryIdentity,
      'élève@example.edu',
      'rl:v1:k1:2f3b1d17eda328b91ae1b8f735ec57f93ff1726c8da86a0d86f833b362ed4379',
      'rl:v1:k2:349f63563f995f0b9c8fbe6e5bf40ea475e0d47b97aaa95a97be578ce36c7053',
    ],
  ])(
    'matches immutable v1 vectors for %j / %s',
    (policy, value, firstKey, secondKey) => {
      const service = new RateLimitBucketKeyService(
        createConfig(
          2,
          new Map([
            [2, Buffer.alloc(32, 5)],
            [1, Buffer.alloc(32, 4)],
          ]),
        ),
      );

      expect(service.deriveKeys(policy, value)).toEqual({
        protocolVersion: 1,
        activeKeyVersion: 2,
        buckets: [
          { keyVersion: 1, key: firstKey },
          { keyVersion: 2, key: secondKey },
        ],
      });
    },
  );

  it.each([
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['0:0:0:0:0:ffff:c000:201', '192.0.2.1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:10.0.0.1', '10.0.0.1'],
    ['::192.0.2.1', '::c000:201'],
  ])(
    'derives identical keys for equivalent IP literals %s and %s',
    (first, second) => {
      const service = new RateLimitBucketKeyService(createConfig());

      expect(service.deriveKeys(requestPolicy, first)).toEqual(
        service.deriveKeys(requestPolicy, second),
      );
    },
  );

  it('keeps IPv4-compatible IPv6 distinct from IPv4', () => {
    const service = new RateLimitBucketKeyService(createConfig());

    expect(service.deriveKeys(requestPolicy, '::192.0.2.1')).not.toEqual(
      service.deriveKeys(requestPolicy, '192.0.2.1'),
    );
  });

  it('separates every accepted policy and characteristic kind', () => {
    const service = new RateLimitBucketKeyService(createConfig());
    const values = {
      IP: '192.0.2.1',
      IDENTITY: 'student@example.edu',
      CHALLENGE_ID: challengeId,
    };
    const policies = [...Object.values(authPolicies), requestPolicy];
    const keys = policies.map(
      (policy) =>
        service.deriveKeys(policy, values[policy.characteristicKind]).buckets[0]
          .key,
    );

    expect(new Set(policies.map((policy) => policy.id)).size).toBe(9);
    expect(new Set(keys).size).toBe(9);
    expect(
      service.deriveKeys(
        { id: 'TEST_POLICY', characteristicKind: 'IP' },
        '192.0.2.1',
      ),
    ).not.toEqual(
      service.deriveKeys(
        { id: 'TEST_POLICY', characteristicKind: 'IDENTITY' },
        '192.0.2.1',
      ),
    );
  });

  it('changes keys for different identities, IPs, and challenges', () => {
    const service = new RateLimitBucketKeyService(createConfig());

    expect(
      service.deriveKeys(authPolicies.deliveryIdentity, 'first@example.edu'),
    ).not.toEqual(
      service.deriveKeys(authPolicies.deliveryIdentity, 'second@example.edu'),
    );
    expect(service.deriveKeys(requestPolicy, '192.0.2.1')).not.toEqual(
      service.deriveKeys(requestPolicy, '192.0.2.2'),
    );
    expect(
      service.deriveKeys(authPolicies.challengeDeliveryCooldown, challengeId),
    ).not.toEqual(
      service.deriveKeys(
        authPolicies.challengeDeliveryCooldown,
        '123e4567-e89b-42d3-a456-426614174001',
      ),
    );
  });

  it('keeps retained bucket keys stable while adding or activating a new key version', () => {
    const old = new RateLimitBucketKeyService(createConfig());
    const keys = new Map([
      [2, Buffer.alloc(32, 5)],
      [1, Buffer.alloc(32, 4)],
    ]);
    const staged = new RateLimitBucketKeyService(createConfig(1, keys));
    const promoted = new RateLimitBucketKeyService(createConfig(2, keys));
    const policy = authPolicies.identityDeliveryCooldown;
    const value = 'student@example.edu';

    expect(staged.deriveKeys(policy, value).buckets[0]).toEqual(
      old.deriveKeys(policy, value).buckets[0],
    );
    expect(promoted.deriveKeys(policy, value).buckets).toEqual(
      staged.deriveKeys(policy, value).buckets,
    );
    expect(promoted.deriveKeys(policy, value).activeKeyVersion).toBe(2);
  });

  it('snapshots keys and settings without exposing subject or secret material', () => {
    const key = Buffer.alloc(32, 4);
    const keys = new Map([[1, key]]);
    const config = createConfig(1, keys);
    const service = new RateLimitBucketKeyService(config);
    const result = service.deriveKeys(
      authPolicies.deliveryIdentity,
      'student@example.edu',
    );

    key.fill(0);
    keys.clear();
    config.set('RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION', 2);
    config.set('AUTH_DELIVERY_IDENTITY_BURST', 999);
    expect(
      service.deriveKeys(authPolicies.deliveryIdentity, 'student@example.edu'),
    ).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.buckets)).toBe(true);
    expect(Object.isFrozen(result.buckets[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain('student@example.edu');
    expect(JSON.stringify(result)).not.toContain(
      Buffer.alloc(32, 4).toString('base64'),
    );
    expect(result.buckets[0].key).toMatch(/^rl:v1:k1:[a-f0-9]{64}$/);
  });

  it.each([
    undefined,
    '',
    ' 192.0.2.1',
    '192.0.2.1:443',
    '192.0.2.1,192.0.2.2',
    'fe80::1%eth0',
  ])('rejects invalid IP %s without a fallback', (value) => {
    const service = new RateLimitBucketKeyService(createConfig());
    expect(() => service.deriveKeys(requestPolicy, value)).toThrow(
      new TypeError('Source IP must be a single valid IP literal.'),
    );
  });

  it.each([
    undefined,
    '',
    'Student@example.edu',
    ' student@example.edu',
    'student@example.edu\n',
    'student\0@example.edu',
    '\ud800@example.edu',
  ])('rejects invalid or non-normalized identity %s', (value) => {
    const service = new RateLimitBucketKeyService(createConfig());
    expect(() =>
      service.deriveKeys(authPolicies.deliveryIdentity, value),
    ).toThrow(TypeError);
  });

  it.each([
    undefined,
    '',
    challengeId.toUpperCase(),
    `${challengeId}\n`,
    'invalid-id',
  ])('rejects non-canonical challenge ID %s', (value) => {
    const service = new RateLimitBucketKeyService(createConfig());
    expect(() =>
      service.deriveKeys(authPolicies.challengeDeliveryCooldown, value),
    ).toThrow(TypeError);
  });

  it.each(['', 'lowercase', 'AUTH_POLICY\n', 'AUTH_POLICY:IP', 'X'.repeat(97)])(
    'rejects invalid policy ID without echoing it',
    (id) => {
      const service = new RateLimitBucketKeyService(createConfig());
      expect(() =>
        service.deriveKeys({ id, characteristicKind: 'IP' }, '192.0.2.1'),
      ).toThrow(new TypeError('Rate-limit policy identifier is invalid.'));
    },
  );

  it('rejects an unsupported characteristic kind and an unavailable active key', () => {
    const service = new RateLimitBucketKeyService(createConfig());
    const policy = {
      id: 'AUTH_POLICY',
      characteristicKind: 'DEVICE',
    } as unknown as RateLimitBucketPolicy;
    expect(() => service.deriveKeys(policy, 'device')).toThrow(
      new TypeError('Rate-limit characteristic kind is invalid.'),
    );
    expect(() => new RateLimitBucketKeyService(createConfig(2))).toThrow(
      'Rate-limit active key version is unavailable.',
    );
  });

  it.each(['RATE_LIMIT_HMAC_KEYS', 'RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION'])(
    'requires %s without using an implicit default',
    (key) => {
      const config = createConfig();
      config.set(key, undefined);
      expect(() => new RateLimitBucketKeyService(config)).toThrow(key);
    },
  );
});
