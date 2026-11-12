import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { GcraAdmissionRepository } from '../repositories/gcra-admission.repository';
import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';
import { GcraAdmissionConfigService } from './gcra-admission-config.service';
import { RateLimitBucketKeyService } from './rate-limit-bucket-key.service';
import type {
  GcraAdmissionInput,
  GcraAdmissionResult,
  GcraMultiAdmissionResult,
} from '../types/gcra-admission.type';
import { chargeGcra } from '../utils/gcra-state.util';
import {
  prepareGcraAdmissions,
  assessGcraAdmissions,
  type PreparedGcraAdmission,
} from '../utils/gcra-admission-plan.util';
import {
  reserveRateLimitTransaction,
  withRateLimitSavepoint,
} from '../utils/rate-limit-transaction.util';
import { isRetryableGcraTransactionError } from '../utils/is-retryable-gcra-transaction-error.util';

@Injectable()
export class GcraAdmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly derivation: RateLimitBucketKeyService,
    private readonly repository: GcraAdmissionRepository,
    private readonly config: GcraAdmissionConfigService,
  ) {}

  /** Owns an independent unit-charge transaction; not failure-only verification. */
  async consume(input: GcraAdmissionInput): Promise<GcraAdmissionResult> {
    const result = await this.consumeMany([input]);
    if (result.allowed) return result;
    // Preserve the existing single-policy result shape.
    return Object.freeze({
      allowed: false,
      operationNowMicros: result.operationNowMicros,
      retryAfterSeconds: result.retryAfterSeconds,
    });
  }

  /** Commits or rolls back the complete policy set in one owned transaction. */
  async consumeMany(
    inputs: readonly GcraAdmissionInput[],
  ): Promise<GcraMultiAdmissionResult> {
    const prepared = this.prepareMany(inputs);
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      let callbackCompleted = false;
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('lock_timeout', ${`${this.config.timeoutSeconds}s`}, true)`;
            const result = await this.admitPrepared(transaction, prepared);
            callbackCompleted = true;
            return result;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: this.config.timeoutSeconds * 1000,
            maxWait: this.config.maxWaitSeconds * 1000,
          },
        );
      } catch (error) {
        if (isRetryableGcraTransactionError(error)) {
          if (attempt < this.config.maxAttempts) continue;
          throw new GcraAdmissionInfrastructureError('RETRY_EXHAUSTED');
        }
        if (error instanceof GcraAdmissionInfrastructureError) throw error;
        throw new GcraAdmissionInfrastructureError(
          callbackCompleted ? 'COMMIT_OUTCOME_UNKNOWN' : 'STATE_UNAVAILABLE',
        );
      }
    }
    throw new GcraAdmissionInfrastructureError('RETRY_EXHAUSTED');
  }

  /** One complete policy set per interactive transaction. The owner commits,
   * bounds waiting, and retries the whole transaction after confirmed aborts. */
  async consumeManyInTransaction(
    transaction: Prisma.TransactionClient,
    inputs: readonly GcraAdmissionInput[],
  ): Promise<GcraMultiAdmissionResult> {
    reserveRateLimitTransaction(transaction);
    const prepared = this.prepareMany(inputs);
    return withRateLimitSavepoint(transaction, this.repository, () =>
      this.admitPrepared(transaction, prepared),
    );
  }

  private async admitPrepared(
    transaction: Prisma.TransactionClient,
    prepared: readonly PreparedGcraAdmission[],
  ): Promise<GcraMultiAdmissionResult> {
    const keys = [...new Set(prepared.flatMap((item) => item.keys))];
    // Lock the entire union once; never iterate policy-by-policy to acquire locks.
    await this.repository.lockAliases(transaction, keys);
    const rows = await this.repository.readAliases(transaction, keys);
    const operationNowMicros =
      await this.repository.operationNowMicros(transaction);
    const decisions = assessGcraAdmissions(prepared, rows, operationNowMicros);
    const denied = decisions.filter(({ evaluation }) => !evaluation.allowed);
    if (denied.length > 0) {
      return Object.freeze({
        allowed: false,
        operationNowMicros,
        retryAfterSeconds: denied.reduce(
          (latest, { evaluation }) =>
            evaluation.retryAfterSeconds > latest
              ? evaluation.retryAfterSeconds
              : latest,
          0n,
        ),
        deniedPolicyIds: Object.freeze(denied.map(({ item }) => item.policyId)),
      });
    }
    // Compute every charge before the first write, then persist all in this tx.
    const charges = decisions.map(({ item, state }) => ({
      item,
      state: chargeGcra(state, item.settings, operationNowMicros),
    }));
    for (const { item, state } of charges) {
      await this.repository.writeAliases(
        transaction,
        item.keys,
        item.policyId,
        state,
      );
    }
    return Object.freeze({ allowed: true, operationNowMicros });
  }

  private prepareMany(
    inputs: readonly GcraAdmissionInput[],
  ): readonly PreparedGcraAdmission[] {
    return prepareGcraAdmissions(inputs, this.derivation);
  }
}
