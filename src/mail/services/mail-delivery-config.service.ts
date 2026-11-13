import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailDeliveryConfigService {
  readonly maxAgeSeconds: number;
  readonly leaseSeconds: number;
  readonly httpTimeoutSeconds: number;
  readonly intervalSeconds: number;
  readonly batchSize: number;
  readonly retentionSeconds: number;
  readonly activeKeyVersion: number;
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(config: ConfigService) {
    this.maxAgeSeconds = config.getOrThrow<number>(
      'MAIL_DELIVERY_MAX_AGE_SECONDS',
    );
    this.leaseSeconds = config.getOrThrow<number>(
      'MAIL_DELIVERY_LEASE_SECONDS',
    );
    this.httpTimeoutSeconds = config.getOrThrow<number>(
      'MAIL_DELIVERY_HTTP_TIMEOUT_SECONDS',
    );
    this.intervalSeconds = config.getOrThrow<number>(
      'MAIL_DELIVERY_WORKER_INTERVAL_SECONDS',
    );
    this.batchSize = config.getOrThrow<number>(
      'MAIL_DELIVERY_WORKER_BATCH_SIZE',
    );
    this.retentionSeconds = config.getOrThrow<number>(
      'NOTIFICATION_DELIVERY_RETENTION_SECONDS',
    );
    this.activeKeyVersion = config.getOrThrow<number>(
      'MAIL_DELIVERY_ENCRYPTION_ACTIVE_KEY_VERSION',
    );
    const keys = config.getOrThrow<ReadonlyMap<number, Buffer>>(
      'MAIL_DELIVERY_ENCRYPTION_KEYS',
    );
    this.keys = new Map(
      [...keys].map(([version, key]) => [version, Buffer.from(key)]),
    );
  }
  key(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new MailPayloadError('KEY_UNAVAILABLE');
    return Buffer.from(key);
  }
}

export class MailPayloadError extends Error {
  constructor(readonly reason: 'KEY_UNAVAILABLE' | 'INVALID_ENVELOPE') {
    super('Mail payload is unavailable.');
  }
}
