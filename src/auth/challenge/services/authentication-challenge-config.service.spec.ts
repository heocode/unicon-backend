import { InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';

describe('AuthenticationChallengeConfigService', () => {
  const hmacKey = Buffer.alloc(32, 1);
  const encryptionKey = Buffer.alloc(32, 2);

  function createService(): AuthenticationChallengeConfigService {
    return new AuthenticationChallengeConfigService(
      new ConfigService({
        AUTH_CHALLENGE_TTL_SECONDS: 600,
        AUTH_CHALLENGE_MAX_ATTEMPTS: 5,
        AUTH_CHALLENGE_RETENTION_SECONDS: 86_400,
        AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION: 2,
        AUTH_CHALLENGE_HMAC_KEYS: new Map([
          [1, Buffer.alloc(32, 3)],
          [2, hmacKey],
        ]),
        AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION: 1,
        AUTH_CHALLENGE_ENCRYPTION_KEYS: new Map([[1, encryptionKey]]),
      }),
    );
  }

  it('exposes validated challenge policy and active key versions', () => {
    const service = createService();

    expect(service.ttlSeconds).toBe(600);
    expect(service.maxAttempts).toBe(5);
    expect(service.retentionSeconds).toBe(86_400);
    expect(service.activeHmacKeyVersion).toBe(2);
    expect(service.activeEncryptionKeyVersion).toBe(1);
  });

  it('resolves current and historical key versions', () => {
    const service = createService();

    expect(service.getHmacKey(1)).toEqual(Buffer.alloc(32, 3));
    expect(service.getHmacKey(2)).toEqual(hmacKey);
    expect(service.getEncryptionKey(1)).toEqual(encryptionKey);
  });

  it('returns a defensive copy of key material', () => {
    const service = createService();
    const resolvedKey = service.getHmacKey(2);

    resolvedKey.fill(0);

    expect(service.getHmacKey(2)).toEqual(hmacKey);
  });

  it('rejects an unavailable key version without exposing key material', () => {
    const service = createService();

    expect(() => service.getHmacKey(99)).toThrow(
      new InternalServerErrorException(
        'Authentication challenge key version is unavailable.',
      ),
    );
  });
});
