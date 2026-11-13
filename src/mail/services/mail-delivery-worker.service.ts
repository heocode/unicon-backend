import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import type { NotificationDelivery } from '../../generated/prisma/client';
import { MailDeliveryRepository } from '../repositories/mail-delivery.repository';
import type {
  MailWorkResult,
  StoredMailPayload,
} from '../types/mail-delivery.type';
import {
  MailDeliveryConfigService,
  MailPayloadError,
} from './mail-delivery-config.service';
import { MailDeliveryEncryptionService } from './mail-delivery-encryption.service';
import {
  ResendMailTransportService,
  type ResendMailTransportResult,
} from './resend-mail-transport.service';

const PERMANENT_REJECTIONS = new Set([
  'missing_api_key',
  'restricted_api_key',
  'invalid_api_key',
  'invalid_access',
  'security_error',
  'invalid_from_address',
  'invalid_region',
  'invalid_idempotency_key',
  'validation_error',
  'not_found',
  'method_not_allowed',
  'invalid_idempotent_request',
  'invalid_attachment',
  'invalid_parameter',
  'missing_required_field',
]);

@Injectable()
export class MailDeliveryWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MailDeliveryWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private wake: NodeJS.Timeout | null = null;
  private active: Promise<readonly MailWorkResult[]> | null = null;
  private stopping = false;
  constructor(
    private readonly repository: MailDeliveryRepository,
    private readonly encryption: MailDeliveryEncryptionService,
    private readonly transport: ResendMailTransportService,
    private readonly config: MailDeliveryConfigService,
  ) {}
  onModuleInit(): void {
    this.timer = setInterval(
      () => this.scheduled(),
      this.config.intervalSeconds * 1000,
    );
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
    this.timer = null;
    this.wake = null;
    await this.active;
  }
  runOnce(): Promise<readonly MailWorkResult[]> {
    if (this.stopping || this.active) return Promise.resolve([]);
    this.active = this.cycle().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private scheduled(): void {
    void this.runOnce()
      .then((results) => {
        const timed = results.find(
          (result) =>
            result.outcome === 'DEFERRED' &&
            result.retryNotBeforeMicros !== undefined,
        );
        if (!timed || this.stopping || !this.timer) return;
        if (this.wake) clearTimeout(this.wake);
        const remaining =
          (timed.retryNotBeforeMicros! + 999n) / 1000n - BigInt(Date.now());
        this.wake = setTimeout(
          () => {
            this.wake = null;
            this.scheduled();
          },
          Math.max(
            1,
            Math.min(Number(remaining), this.config.intervalSeconds * 1000),
          ),
        );
        this.wake.unref();
      })
      .catch(() => this.logger.error({ event: 'MAIL_DELIVERY_CYCLE_FAILED' }));
  }
  private async cycle(): Promise<readonly MailWorkResult[]> {
    const results: MailWorkResult[] = [];
    for (let i = 0; i < this.config.batchSize && !this.stopping; i++) {
      const claim = await this.repository.claimNext();
      if (!claim) break;
      try {
        const result = await this.process(claim);
        results.push(result);
        if (result.outcome === 'DEFERRED') break;
      } catch {
        this.logger.error({
          event: 'MAIL_DELIVERY_PROCESSING_UNAVAILABLE',
          deliveryId: claim.id,
        });
        break;
      }
    }
    return results;
  }
  async process(claim: NotificationDelivery): Promise<MailWorkResult> {
    const prepared = await this.repository.prepare(claim);
    if (prepared.outcome !== 'READY') return prepared;
    let payload: StoredMailPayload;
    try {
      payload = this.encryption.decrypt(prepared.row);
    } catch (error) {
      if (
        error instanceof MailPayloadError &&
        error.reason === 'KEY_UNAVAILABLE'
      ) {
        this.logger.error({
          event: 'MAIL_DELIVERY_KEY_UNAVAILABLE',
          deliveryId: claim.id,
        });
        return { outcome: await this.repository.defer(claim) };
      }
      return {
        outcome: (await this.repository.fail(claim, 'MAIL_ENVELOPE_INVALID'))
          ? 'FAILED'
          : 'LEASE_LOST',
      };
    }
    let start: 'STARTED' | 'FAILED' | 'LEASE_LOST' | undefined;
    let response: ResendMailTransportResult;
    try {
      response = await this.transport.send(
        { idempotencyKey: claim.id, content: payload.content },
        AbortSignal.timeout(this.config.httpTimeoutSeconds * 1000),
        async () => {
          start = await this.repository.startAttempt(claim, payload);
          return start === 'STARTED';
        },
      );
    } catch {
      this.logger.error({
        event: 'MAIL_DELIVERY_SUBMISSION_UNAVAILABLE',
        deliveryId: claim.id,
      });
      // A possibly committed start is not refunded: defer refuses a charged lease.
      return { outcome: await this.repository.defer(claim) };
    }
    if (response.outcome === 'NOT_SUBMITTED')
      return { outcome: start === 'FAILED' ? 'FAILED' : 'LEASE_LOST' };
    if (response.outcome === 'DEFERRED' || response.outcome === 'PAUSED') {
      const boundary =
        response.outcome === 'DEFERRED'
          ? response.retryNotBeforeMicros
          : undefined;
      return {
        outcome: await this.repository.defer(claim, boundary),
        ...(boundary === undefined ? {} : { retryNotBeforeMicros: boundary }),
      };
    }
    if (
      'pressurePersistence' in response &&
      response.pressurePersistence === 'FAILED'
    )
      this.logger.error({
        event: 'MAIL_PROVIDER_PRESSURE_PERSISTENCE_FAILED',
        providerOutcome: response.outcome,
        deliveryId: claim.id,
      });
    if (response.outcome === 'ACCEPTED')
      return {
        outcome: (await this.repository.sent(claim, response.providerMessageId))
          ? 'SENT'
          : 'LEASE_LOST',
      };
    if (response.outcome === 'OUTCOME_UNKNOWN')
      return {
        outcome: await this.repository.retry(
          claim,
          'MAIL_PROVIDER_OUTCOME_UNKNOWN',
        ),
      };
    const permanent =
      response.providerRestriction === null &&
      (response.statusCode === 401 ||
        response.statusCode === 403 ||
        (response.errorName !== undefined &&
          PERMANENT_REJECTIONS.has(response.errorName)));
    if (permanent && response.pressurePersistence !== 'FAILED')
      return {
        outcome: (await this.repository.fail(
          claim,
          'MAIL_PROVIDER_REQUEST_REJECTED',
        ))
          ? 'FAILED'
          : 'LEASE_LOST',
      };
    return {
      outcome: await this.repository.retry(
        claim,
        response.pressurePersistence === 'FAILED'
          ? 'MAIL_PRESSURE_PERSISTENCE_FAILED'
          : response.providerRestriction
            ? 'MAIL_PROVIDER_LIMITED'
            : 'MAIL_PROVIDER_OUTCOME_UNKNOWN',
        response.headers,
      ),
    };
  }
}
