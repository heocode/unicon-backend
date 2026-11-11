import { Injectable } from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';
import { GcraAdmissionRepository } from '../repositories/gcra-admission.repository';
import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';
import { GcraAdmissionConfigService } from './gcra-admission-config.service';
import { RateLimitBucketKeyService } from './rate-limit-bucket-key.service';
import type {
  GcraAdmissionInput,
  GcraAdmissionResult,
  GcraMultiAdmissionResult,
} from '../types/gcra-admission.type';
import { fromGcraPersistenceData } from '../utils/gcra-state-persistence.util';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
  reconcileGcraStates,
} from '../utils/gcra-state.util';
import { isRetryableGcraTransactionError } from '../utils/is-retryable-gcra-transaction-error.util';

type PreparedAdmission = Readonly<{
  policyId: string;
  settings: GcraPolicyConfig;
  keys: readonly string[];
}>;

@Injectable()
export class GcraAdmissionService {
  private static readonly externalTransactions =
    new WeakSet<Prisma.TransactionClient>();
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
    if (
      ('$connect' in transaction && transaction.$connect !== undefined) ||
      GcraAdmissionService.externalTransactions.has(transaction)
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
    }
    GcraAdmissionService.externalTransactions.add(transaction);
    const prepared = this.prepareMany(inputs);
    try {
      const isolation = await this.repository.isolationLevel(transaction);
      if (isolation !== 'read committed' && isolation !== 'serializable') {
        throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
      }
      // Also rejects a non-transactional client before any admission mutation.
      await transaction.$executeRaw`SAVEPOINT unicon_gcra_admission`;
    } catch (error) {
      throw this.externalFailure(error);
    }
    try {
      const result = await this.admitPrepared(transaction, prepared);
      await transaction.$executeRaw`RELEASE SAVEPOINT unicon_gcra_admission`;
      return result;
    } catch (error) {
      try {
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_gcra_admission`;
        await transaction.$executeRaw`RELEASE SAVEPOINT unicon_gcra_admission`;
      } catch {
        throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
      }
      throw this.externalFailure(error);
    }
  }

  private externalFailure(error: unknown): GcraAdmissionInfrastructureError {
    if (isRetryableGcraTransactionError(error)) {
      return new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED');
    }
    return error instanceof GcraAdmissionInfrastructureError
      ? error
      : new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
  }

  private async admitPrepared(
    transaction: Prisma.TransactionClient,
    prepared: readonly PreparedAdmission[],
  ): Promise<GcraMultiAdmissionResult> {
    const keys = [...new Set(prepared.flatMap((item) => item.keys))];
    // Lock the entire union once; never iterate policy-by-policy to acquire locks.
    await this.repository.lockAliases(transaction, keys);
    const rows = await this.repository.readAliases(transaction, keys);
    const operationNowMicros =
      await this.repository.operationNowMicros(transaction);
    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const decisions = prepared.map((item) => {
      let state: ReturnType<typeof reconcileGcraStates>;
      try {
        const aliases = item.keys.flatMap((key) => {
          const row = rowsByKey.get(key);
          return row ? [row] : [];
        });
        if (aliases.some((row) => row.policyId !== item.policyId)) {
          throw new Error('GCRA policy identifier mismatch.');
        }
        state = reconcileGcraStates(
          aliases.map(fromGcraPersistenceData),
          item.settings,
        );
      } catch {
        throw new GcraAdmissionInfrastructureError('INVALID_STATE');
      }
      return {
        item,
        state,
        evaluation: evaluateGcra(state, item.settings, operationNowMicros),
      };
    });
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
  ): readonly PreparedAdmission[] {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
    const prepared = inputs.map((input: GcraAdmissionInput) =>
      this.prepare(input),
    );
    if (
      new Set(prepared.map((item) => item.policyId)).size !== prepared.length
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
    return prepared.sort((left, right) =>
      left.policyId < right.policyId
        ? -1
        : left.policyId > right.policyId
          ? 1
          : 0,
    );
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
