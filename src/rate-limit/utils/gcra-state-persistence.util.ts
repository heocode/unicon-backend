import type { GcraRateLimit } from '../../generated/prisma/client';

import type { GcraState } from '../types/gcra-state.type';
import { createGcraState, getGcraIdleAfterMicros } from './gcra-state.util';

type StoredGcraState = Pick<
  GcraRateLimit,
  | 'tatNumerator'
  | 'tatDenominator'
  | 'idleAfterMicros'
  | 'burst'
  | 'rate'
  | 'periodSeconds'
>;

export function toGcraPersistenceData(state: GcraState) {
  const current = createGcraState(state.tat, state.policy);
  return {
    tatNumerator: current.tat.numerator.toString(),
    tatDenominator: current.tat.denominator.toString(),
    idleAfterMicros: getGcraIdleAfterMicros(current).toString(),
    burst: BigInt(current.policy.burst),
    rate: BigInt(current.policy.rate),
    periodSeconds: BigInt(current.policy.periodSeconds),
  };
}

export function fromGcraPersistenceData(row: StoredGcraState): GcraState {
  for (const value of [
    row.tatNumerator,
    row.tatDenominator,
    row.idleAfterMicros,
  ]) {
    if (!value.isFinite() || !value.isInteger()) {
      throw new Error('Persisted GCRA time must contain finite integers.');
    }
  }
  const state = createGcraState(
    {
      numerator: BigInt(row.tatNumerator.toFixed(0)),
      denominator: BigInt(row.tatDenominator.toFixed(0)),
    },
    {
      burst: readPolicyValue(row.burst),
      rate: readPolicyValue(row.rate),
      periodSeconds: readPolicyValue(row.periodSeconds),
    },
  );
  if (
    getGcraIdleAfterMicros(state) !== BigInt(row.idleAfterMicros.toFixed(0))
  ) {
    throw new Error('Persisted GCRA full-recovery boundary is inconsistent.');
  }
  return state;
}

function readPolicyValue(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      'Persisted GCRA policy values must be positive safe integers.',
    );
  }
  return Number(value);
}
