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
} from '../types/gcra-admission.type';
import { fromGcraPersistenceData } from '../utils/gcra-state-persistence.util';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
  reconcileGcraStates,
} from '../utils/gcra-state.util';
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
    const prepared = this.prepare(input);
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      let callbackCompleted = false;
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            await transaction.$executeRaw`SELECT set_config('lock_timeout', ${`${this.config.timeoutSeconds}s`}, true)`;
            await this.repository.lockAliases(transaction, prepared.keys);
            const rows = await this.repository.readAliases(
              transaction,
              prepared.keys,
            );
            // Row locks can also wait. Sample once, after every serialization wait.
            const operationNowMicros =
              await this.repository.operationNowMicros(transaction);
            let state: ReturnType<typeof reconcileGcraStates>;
            try {
              if (rows.some((row) => row.policyId !== prepared.policyId)) {
                throw new Error('GCRA policy identifier mismatch.');
              }
              state = reconcileGcraStates(
                rows.map(fromGcraPersistenceData),
                prepared.settings,
              );
            } catch {
              throw new GcraAdmissionInfrastructureError('INVALID_STATE');
            }
            const evaluation = evaluateGcra(
              state,
              prepared.settings,
              operationNowMicros,
            );
            if (!evaluation.allowed) {
              callbackCompleted = true;
              return Object.freeze({
                allowed: false as const,
                operationNowMicros,
                retryAfterSeconds: evaluation.retryAfterSeconds,
              });
            }
            const charged = chargeGcra(
              state,
              prepared.settings,
              operationNowMicros,
            );
            await this.repository.writeAliases(
              transaction,
              prepared.keys,
              prepared.policyId,
              charged,
            );
            callbackCompleted = true;
            return Object.freeze({
              allowed: true as const,
              operationNowMicros,
            });
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

  private prepare(input: GcraAdmissionInput) {
    try {
      const policy = {
        id: input.policy.id,
        characteristicKind: input.policy.characteristicKind,
      };
      const settings = createGcraState(
        { numerator: 0n, denominator: 1n },
        input.settings,
      ).policy;
      const keySet = this.derivation.deriveKeys(policy, input.characteristic);
      return {
        policyId: policy.id,
        settings,
        keys: keySet.buckets.map((bucket) => bucket.key),
      };
    } catch {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
  }
}
