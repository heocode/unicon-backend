// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Node.js
import { createHmac } from 'node:crypto';

// Internal types
import type { VersionedKeyring } from '../../config/types/versioned-keyring.type';
import type {
  RateLimitBucketKeySet,
  RateLimitBucketPolicy,
} from '../types/rate-limit-bucket-key.type';

// Internal utilities
import { assertCanonicalUuid } from '../../common/utils/assert-canonical-uuid.util';
import { canonicalizeIp } from '../../common/utils/canonicalize-ip.util';
import { encodeLengthPrefixedFields } from '../../common/utils/encode-length-prefixed-fields.util';

const BUCKET_HMAC_DOMAIN = 'unicon.rate-limit.bucket.v1';
const POLICY_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;

@Injectable()
export class RateLimitBucketKeyService {
  private readonly activeKeyVersion: number;
  private readonly keyring: VersionedKeyring;

  constructor(configService: ConfigService) {
    this.activeKeyVersion = configService.getOrThrow<number>(
      'RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION',
    );
    const keyring = configService.getOrThrow<VersionedKeyring>(
      'RATE_LIMIT_HMAC_KEYS',
    );

    if (!keyring.has(this.activeKeyVersion)) {
      throw new Error('Rate-limit active key version is unavailable.');
    }

    // Capture a private copy once; configuration mutation cannot change a call.
    this.keyring = new Map(
      [...keyring.entries()]
        .sort(([left], [right]) => left - right)
        .map(([version, key]) => [version, Buffer.from(key)]),
    );
  }

  deriveKeys(
    policy: RateLimitBucketPolicy,
    value: string | undefined,
  ): RateLimitBucketKeySet {
    if (
      !policy ||
      typeof policy.id !== 'string' ||
      policy.id.length > 96 ||
      policy.id !== policy.id.trim() ||
      !POLICY_ID_PATTERN.test(policy.id)
    ) {
      throw new TypeError('Rate-limit policy identifier is invalid.');
    }

    const canonicalValue = this.canonicalizeCharacteristic(policy, value);
    const payload = encodeLengthPrefixedFields([
      Buffer.from(BUCKET_HMAC_DOMAIN, 'utf8'),
      Buffer.from(policy.id, 'utf8'),
      Buffer.from(policy.characteristicKind, 'utf8'),
      Buffer.from(canonicalValue, 'utf8'),
    ]);

    const buckets = [...this.keyring.entries()].map(([keyVersion, key]) => {
      const digest = createHmac('sha256', key).update(payload).digest('hex');

      return Object.freeze({
        keyVersion,
        key: `rl:v1:k${keyVersion}:${digest}`,
      });
    });

    return Object.freeze({
      protocolVersion: 1,
      activeKeyVersion: this.activeKeyVersion,
      buckets: Object.freeze(buckets),
    });
  }

  private canonicalizeCharacteristic(
    policy: RateLimitBucketPolicy,
    value: string | undefined,
  ): string {
    if (policy.characteristicKind === 'IP') {
      return canonicalizeIp(value);
    }

    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value !== value.trim() ||
      /\p{Cc}/u.test(value) ||
      Buffer.from(value, 'utf8').toString('utf8') !== value
    ) {
      throw new TypeError('Rate-limit characteristic is invalid.');
    }

    if (policy.characteristicKind === 'CHALLENGE_ID') {
      assertCanonicalUuid(value);
      return value;
    }

    if (policy.characteristicKind === 'IDENTITY') {
      if (value !== value.toLowerCase()) {
        throw new TypeError('Rate-limit identity must already be normalized.');
      }

      // HTTP validates email syntax/domain; verification supplies persisted identity.
      return value;
    }

    throw new TypeError('Rate-limit characteristic kind is invalid.');
  }
}
