import type { GcraRateLimit } from '../../generated/prisma/client';

import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';
import { GcraAdmissionInfrastructureError } from '../errors/gcra-admission-infrastructure.error';
import type { RateLimitBucketKeyService } from '../services/rate-limit-bucket-key.service';
import type { GcraAdmissionInput } from '../types/gcra-admission.type';
import { fromGcraPersistenceData } from './gcra-state-persistence.util';
import {
  createGcraState,
  evaluateGcra,
  reconcileGcraStates,
} from './gcra-state.util';

export type PreparedGcraAdmission = Readonly<{
  policyId: string;
  settings: GcraPolicyConfig;
  keys: readonly string[];
}>;

/** Shared preparation for request GCRA and the fixed auth Delivery rate policies. */
export function prepareGcraAdmissions(
  inputs: readonly GcraAdmissionInput[],
  derivation: RateLimitBucketKeyService,
): readonly PreparedGcraAdmission[] {
  try {
    if (!Array.isArray(inputs) || inputs.length === 0)
      throw new Error('Invalid GCRA set.');
    const prepared = inputs.map((input: GcraAdmissionInput) => {
      const policy = {
        id: input.policy.id,
        characteristicKind: input.policy.characteristicKind,
      };
      const settings = createGcraState(
        { numerator: 0n, denominator: 1n },
        input.settings,
      ).policy;
      const keySet = derivation.deriveKeys(policy, input.characteristic);
      return {
        policyId: policy.id,
        settings,
        keys: keySet.buckets.map((bucket) => bucket.key),
      };
    });
    if (new Set(prepared.map((item) => item.policyId)).size !== prepared.length)
      throw new Error('Duplicate GCRA policy.');
    return prepared.sort((left, right) =>
      left.policyId < right.policyId
        ? -1
        : left.policyId > right.policyId
          ? 1
          : 0,
    );
  } catch {
    throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
  }
}

/** Caller has already locked every participating alias and sampled fresh DB time. */
export function assessGcraAdmissions(
  prepared: readonly PreparedGcraAdmission[],
  rows: readonly GcraRateLimit[],
  operationNowMicros: bigint,
) {
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  return prepared.map((item) => {
    let state: ReturnType<typeof reconcileGcraStates>;
    try {
      const aliases = item.keys.flatMap((key) => {
        const row = rowsByKey.get(key);
        return row ? [row] : [];
      });
      if (aliases.some((row) => row.policyId !== item.policyId))
        throw new Error('GCRA policy identifier mismatch.');
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
}
