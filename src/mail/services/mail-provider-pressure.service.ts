import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { GcraAdmissionInfrastructureError } from '../../rate-limit/errors/gcra-admission-infrastructure.error';
import { GcraAdmissionRepository } from '../../rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../../rate-limit/services/gcra-admission-config.service';
import { isRetryableGcraTransactionError } from '../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { MAIL_SUBMISSION_GATE } from '../constants/mail-submission-gate.constants';
import { MailProviderPressureRepository } from '../repositories/mail-provider-pressure.repository';
import {
  needsProviderPressure,
  providerRestriction,
  retryAfterBoundary,
  UTC_DAY_MICROS,
  type MailProviderPressureObservation,
} from '../utils/mail-provider-pressure.util';

@Injectable()
export class MailProviderPressureService {
  private readonly fallbackSeconds: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gcra: GcraAdmissionRepository,
    private readonly repository: MailProviderPressureRepository,
    private readonly bounds: GcraAdmissionConfigService,
    config: ConfigService,
  ) {
    this.fallbackSeconds = String(
      config.getOrThrow<number>('MAIL_RESEND_RATE_LIMIT_FALLBACK_SECONDS'),
    );
  }

  async observe(observation: MailProviderPressureObservation): Promise<void> {
    if (!needsProviderPressure(observation)) return;
    await this.transaction(async (tx) => {
      await this.gcra.lockAliases(tx, [MAIL_SUBMISSION_GATE.key]);
      const state = await this.repository.read(tx);
      const now = await this.gcra.operationNowMicros(tx);
      const retryAt = retryAfterBoundary(observation.headers, now);
      const restriction = providerRestriction(observation);
      const rateLimited = restriction === 'RATE_LIMIT';
      const boundary =
        retryAt ??
        (rateLimited
          ? retryAfterBoundary({ 'retry-after': this.fallbackSeconds }, now)!
          : now);
      if (boundary > state.retryNotBeforeMicros)
        state.retryNotBeforeMicros = boundary;
      if (restriction === 'DAILY_QUOTA') {
        const midnight = (now / UTC_DAY_MICROS + 1n) * UTC_DAY_MICROS;
        if (midnight > state.dailyNotBeforeMicros)
          state.dailyNotBeforeMicros = midnight;
      }
      if (restriction === 'MONTHLY_QUOTA') state.monthlyBlocked = true;
      await this.repository.write(tx, state);
    });
  }

  /** Explicit operator recovery after checking provider quota. A stale revision
   * cannot clear a newer observation; timed rate/daily restrictions remain. */
  async clearMonthlyBlock(expectedRevision: bigint): Promise<boolean> {
    return this.transaction(async (tx) => {
      await this.gcra.lockAliases(tx, [MAIL_SUBMISSION_GATE.key]);
      const state = await this.repository.read(tx);
      if (state.revision !== expectedRevision || !state.monthlyBlocked)
        return false;
      state.monthlyBlocked = false;
      await this.repository.write(tx, state);
      return true;
    });
  }

  private async transaction<T>(
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= this.bounds.maxAttempts; attempt++) {
      let callbackCompleted = false;
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${this.bounds.timeoutSeconds}s`}, true)`;
            const result = await work(tx);
            callbackCompleted = true;
            return result;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: this.bounds.timeoutSeconds * 1000,
            maxWait: this.bounds.maxWaitSeconds * 1000,
          },
        );
      } catch (error) {
        if (isRetryableGcraTransactionError(error)) {
          if (attempt < this.bounds.maxAttempts) continue;
          throw new GcraAdmissionInfrastructureError('RETRY_EXHAUSTED');
        }
        if (callbackCompleted)
          throw new GcraAdmissionInfrastructureError('COMMIT_OUTCOME_UNKNOWN');
        if (error instanceof GcraAdmissionInfrastructureError) throw error;
        throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
      }
    }
    throw new GcraAdmissionInfrastructureError('RETRY_EXHAUSTED');
  }
}
