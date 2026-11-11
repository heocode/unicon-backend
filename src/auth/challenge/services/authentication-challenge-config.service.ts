// NestJS
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { VersionedKeyring } from '../../../config/types/versioned-keyring.type';

@Injectable()
export class AuthenticationChallengeConfigService {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly retentionSeconds: number;
  readonly cleanupIntervalSeconds: number;
  readonly cleanupBatchSize: number;
  readonly cleanupMaxBatchesPerRun: number;
  readonly activeHmacKeyVersion: number;
  readonly activeEncryptionKeyVersion: number;

  private readonly hmacKeyring: VersionedKeyring;
  private readonly encryptionKeyring: VersionedKeyring;

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
    this.cleanupIntervalSeconds = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS',
    );
    this.cleanupBatchSize = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_CLEANUP_BATCH_SIZE',
    );
    this.cleanupMaxBatchesPerRun = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN',
    );
    this.activeHmacKeyVersion = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION',
    );
    this.activeEncryptionKeyVersion = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION',
    );
    this.hmacKeyring = configService.getOrThrow<VersionedKeyring>(
      'AUTH_CHALLENGE_HMAC_KEYS',
    );
    this.encryptionKeyring = configService.getOrThrow<VersionedKeyring>(
      'AUTH_CHALLENGE_ENCRYPTION_KEYS',
    );
  }

  getHmacKey(version: number): Buffer {
    return this.getKey(this.hmacKeyring, version);
  }

  getEncryptionKey(version: number): Buffer {
    return this.getKey(this.encryptionKeyring, version);
  }

  private getKey(keyring: VersionedKeyring, version: number): Buffer {
    const key = keyring.get(version);

    if (!key) {
      throw new InternalServerErrorException(
        'Authentication challenge key version is unavailable.',
      );
    }

    return Buffer.from(key);
  }
}
