// NestJS
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { AuthenticationChallengeKeyring } from '../../../config/types/authentication-challenge-keyring.type';

@Injectable()
export class AuthenticationChallengeConfigService {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly retentionSeconds: number;
  readonly activeHmacKeyVersion: number;
  readonly activeEncryptionKeyVersion: number;

  private readonly hmacKeyring: AuthenticationChallengeKeyring;
  private readonly encryptionKeyring: AuthenticationChallengeKeyring;

  constructor(configService: ConfigService) {
    this.ttlSeconds = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_TTL_SECONDS',
    );
    this.maxAttempts = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_MAX_ATTEMPTS',
    );
    this.retentionSeconds = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_RETENTION_SECONDS',
    );
    this.activeHmacKeyVersion = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION',
    );
    this.activeEncryptionKeyVersion = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION',
    );
    this.hmacKeyring = configService.getOrThrow<AuthenticationChallengeKeyring>(
      'AUTH_CHALLENGE_HMAC_KEYS',
    );
    this.encryptionKeyring =
      configService.getOrThrow<AuthenticationChallengeKeyring>(
        'AUTH_CHALLENGE_ENCRYPTION_KEYS',
      );
  }

  getHmacKey(version: number): Buffer {
    return this.getKey(this.hmacKeyring, version);
  }

  getEncryptionKey(version: number): Buffer {
    return this.getKey(this.encryptionKeyring, version);
  }

  private getKey(
    keyring: AuthenticationChallengeKeyring,
    version: number,
  ): Buffer {
    const key = keyring.get(version);

    if (!key) {
      throw new InternalServerErrorException(
        'Authentication challenge key version is unavailable.',
      );
    }

    return Buffer.from(key);
  }
}
