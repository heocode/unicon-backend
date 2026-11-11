import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';
import type {
  GcraEvaluation,
  GcraState,
  GcraTime,
} from '../types/gcra-state.type';

const MICROS_PER_SECOND = 1_000_000n;

export function createGcraState(
  tat: GcraTime,
  policy: GcraPolicyConfig,
): GcraState {
  if (
    typeof tat.numerator !== 'bigint' ||
    tat.numerator < 0n ||
    typeof tat.denominator !== 'bigint' ||
    tat.denominator <= 0n
  ) {
    throw new RangeError('GCRA TAT must be a nonnegative rational time.');
  }
  for (const value of [policy.burst, policy.rate, policy.periodSeconds]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        'GCRA policy values must be positive safe integers.',
      );
    }
  }

  return Object.freeze({
    tat: fraction(tat.numerator, tat.denominator),
    policy: Object.freeze({
      burst: policy.burst,
      rate: policy.rate,
      periodSeconds: policy.periodSeconds,
    }),
  });
}

/** Checks capacity only. Call chargeGcra separately for a committed unit cost. */
export function evaluateGcra(
  state: GcraState | null,
  policy: GcraPolicyConfig,
  nowMicros: bigint,
): GcraEvaluation {
  const now = operationTime(nowMicros);
  const current = matchingState(state, policy, now);
  const eligibleAt = subtract(current.tat, tolerance(policy));
  const wait = subtract(eligibleAt, now);

  return Object.freeze({
    allowed: wait.numerator <= 0n,
    eligibleAt,
    retryAfterSeconds:
      wait.numerator <= 0n
        ? 0n
        : ceilPositive(
            fraction(wait.numerator, wait.denominator * MICROS_PER_SECOND),
          ),
  });
}

export function chargeGcra(
  state: GcraState | null,
  policy: GcraPolicyConfig,
  nowMicros: bigint,
): GcraState {
  if (!evaluateGcra(state, policy, nowMicros).allowed) {
    throw new Error('GCRA charge requires eligible state.');
  }
  const now = operationTime(nowMicros);
  const current = matchingState(state, policy, now);
  return createGcraState(
    add(latest(current.tat, now), interval(policy)),
    policy,
  );
}

/** Full recovery, not merely the next eligibility boundary. */
export function getGcraIdleAfterMicros(state: GcraState): bigint {
  const current = createGcraState(state.tat, state.policy);
  return ceilPositive(current.tat);
}

export function isGcraStateIdle(state: GcraState, nowMicros: bigint): boolean {
  operationTime(nowMicros);
  return nowMicros >= getGcraIdleAfterMicros(state);
}

/** Explicit conservative tuning; never called implicitly by evaluation. */
export function retuneGcraState(
  state: GcraState,
  policy: GcraPolicyConfig,
  nowMicros: bigint,
): GcraState {
  const now = operationTime(nowMicros);
  const current = createGcraState(state.tat, state.policy);
  const target = createGcraState(current.tat, policy);
  if (compare(current.tat, now) <= 0) {
    return target;
  }

  const oldInterval = interval(current.policy);
  const newInterval = interval(policy);
  const debt = subtract(current.tat, now);
  const debtUnits = fraction(
    debt.numerator * oldInterval.denominator,
    debt.denominator * oldInterval.numerator,
  );
  const extraBurst = BigInt(policy.burst) - BigInt(current.policy.burst);
  const newDebtUnits = add(
    debtUnits,
    fraction(extraBurst > 0n ? extraBurst : 0n, 1n),
  );
  const oldEligibleAt = subtract(current.tat, tolerance(current.policy));
  const tat = latest(
    current.tat,
    add(now, multiply(newDebtUnits, newInterval)),
    add(oldEligibleAt, tolerance(policy)),
  );
  return createGcraState(tat, policy);
}

/** Aliases represent one history. Snapshot mismatches need explicit retuning. */
export function reconcileGcraStates(
  states: readonly GcraState[],
  policy: GcraPolicyConfig,
): GcraState | null {
  // Validate configuration even when no alias exists.
  createGcraState(fraction(0n, 1n), policy);
  let result: GcraState | null = null;
  for (const state of states) {
    const current = matchingState(state, policy, fraction(0n, 1n));
    result =
      result === null
        ? current
        : createGcraState(latest(result.tat, current.tat), policy);
  }
  return result;
}

function matchingState(
  state: GcraState | null,
  policy: GcraPolicyConfig,
  now: GcraTime,
): GcraState {
  const current = createGcraState(state?.tat ?? now, policy);
  if (
    state !== null &&
    (state.policy.burst !== policy.burst ||
      state.policy.rate !== policy.rate ||
      state.policy.periodSeconds !== policy.periodSeconds)
  ) {
    throw new Error(
      'GCRA policy snapshot mismatch requires an explicit transition.',
    );
  }
  return current;
}

function operationTime(nowMicros: bigint): GcraTime {
  if (typeof nowMicros !== 'bigint' || nowMicros < 0n) {
    throw new RangeError(
      'GCRA operation time must be nonnegative integer microseconds.',
    );
  }
  return fraction(nowMicros, 1n);
}

function interval(policy: GcraPolicyConfig): GcraTime {
  return fraction(
    BigInt(policy.periodSeconds) * MICROS_PER_SECOND,
    BigInt(policy.rate),
  );
}

function tolerance(policy: GcraPolicyConfig): GcraTime {
  return multiply(interval(policy), fraction(BigInt(policy.burst) - 1n, 1n));
}

function fraction(numerator: bigint, denominator: bigint): GcraTime {
  let left = numerator < 0n ? -numerator : numerator;
  let right = denominator;
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  return Object.freeze({
    numerator: numerator / left,
    denominator: denominator / left,
  });
}

function add(left: GcraTime, right: GcraTime): GcraTime {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: GcraTime, right: GcraTime): GcraTime {
  return fraction(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function multiply(left: GcraTime, right: GcraTime): GcraTime {
  return fraction(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );
}

function compare(left: GcraTime, right: GcraTime): bigint {
  return (
    left.numerator * right.denominator - right.numerator * left.denominator
  );
}

function latest(...times: GcraTime[]): GcraTime {
  return times.reduce((left, right) =>
    compare(left, right) >= 0n ? left : right,
  );
}

function ceilPositive(value: GcraTime): bigint {
  return (
    value.numerator / value.denominator +
    (value.numerator % value.denominator === 0n ? 0n : 1n)
  );
}
