import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { GcraAdmissionInfrastructureError } from '../../rate-limit/errors/gcra-admission-infrastructure.error';
import { GcraAdmissionRepository } from '../../rate-limit/repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from '../../rate-limit/services/gcra-admission-config.service';
import {
  assessGcraAdmissions,
  type PreparedGcraAdmission,
} from '../../rate-limit/utils/gcra-admission-plan.util';
import {
  chargeGcra,
  createGcraState,
  getGcraIdleAfterMicros,
} from '../../rate-limit/utils/gcra-state.util';
import { isRetryableGcraTransactionError } from '../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { MAIL_SUBMISSION_GATE } from '../constants/mail-submission-gate.constants';
import { MailProviderPressureRepository } from '../repositories/mail-provider-pressure.repository';
import type { MailSubmissionGateResult } from '../types/mail-submission-gate.type';
import { MailSubmissionGateConfigService } from './mail-submission-gate-config.service';

@Injectable()
export class MailSubmissionGateService {
  private readonly prepared: readonly PreparedGcraAdmission[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: GcraAdmissionRepository,
    config: MailSubmissionGateConfigService,
    private readonly bounds: GcraAdmissionConfigService,
    private readonly pressure: MailProviderPressureRepository,
  ) {
    this.prepared = Object.freeze([
      Object.freeze({
        policyId: MAIL_SUBMISSION_GATE.policyId,
        keys: Object.freeze([MAIL_SUBMISSION_GATE.key]),
        settings: createGcraState(
          { numerator: 0n, denominator: 1n },
          config.policy,
        ).policy,
      }),
    ]);
  }

  /** Internal permission acquisition only. No caller transaction, payload, network
   * I/O, sleep, background queue or refund. A granted but unused permission stays
   * spent; an unknown commit is never blindly retried or returned as a grant. */
  async tryAcquire(): Promise<MailSubmissionGateResult> {
    for (let attempt = 1; attempt <= this.bounds.maxAttempts; attempt++) {
      let callbackCompleted = false;
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('lock_timeout', ${`${this.bounds.timeoutSeconds}s`}, true)`;
            const result = await this.acquire(transaction);
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

  private async acquire(
    transaction: Prisma.TransactionClient,
  ): Promise<MailSubmissionGateResult> {
    const keys = this.prepared[0].keys;
    await this.repository.lockAliases(transaction, keys);
    const pressure = await this.pressure.read(transaction);
    const rows = await this.repository.readAliases(transaction, keys);
    // Sample after both advisory and row-lock waits. Do not use JS/transaction-start time.
    const now = await this.repository.operationNowMicros(transaction);
    if (pressure.monthlyBlocked) {
      return Object.freeze({
        outcome: 'PAUSED',
        reason: 'MONTHLY_QUOTA',
        operationNowMicros: now,
      });
    }
    const [{ item, state, evaluation }] = assessGcraAdmissions(
      this.prepared,
      rows,
      now,
    );
    const { numerator, denominator } = evaluation.eligibleAt;
    const boundaries = [
      (numerator + denominator - 1n) / denominator,
      pressure.retryNotBeforeMicros,
      pressure.dailyNotBeforeMicros,
    ];
    const boundary = boundaries.reduce((left, right) =>
      left > right ? left : right,
    );
    if (!evaluation.allowed || boundary > now) {
      return Object.freeze({
        outcome: 'DEFERRED',
        operationNowMicros: now,
        retryNotBeforeMicros: boundary,
      });
    }
    const charged = chargeGcra(state, item.settings, now);
    await this.repository.writeAliases(
      transaction,
      item.keys,
      item.policyId,
      charged,
    );
    return Object.freeze({
      outcome: 'GRANTED',
      operationNowMicros: now,
      nextPermissionNotBeforeMicros: getGcraIdleAfterMicros(charged),
    });
  }
}
