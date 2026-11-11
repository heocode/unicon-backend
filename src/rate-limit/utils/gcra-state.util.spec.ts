import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';
import type { GcraState } from '../types/gcra-state.type';
import {
  chargeGcra,
  createGcraState,
  evaluateGcra,
  getGcraIdleAfterMicros,
  isGcraStateIdle,
  reconcileGcraStates,
  retuneGcraState,
} from './gcra-state.util';

const identity = { burst: 6, rate: 6, periodSeconds: 60 };
const email = { burst: 10, rate: 7, periodSeconds: 3600 };

function exhaust(policy: GcraPolicyConfig, now = 0n): GcraState {
  let state: GcraState | null = null;
  for (let index = 0; index < policy.burst; index++) {
    expect(evaluateGcra(state, policy, now).allowed).toBe(true);
    state = chargeGcra(state, policy, now);
  }
  return state!;
}

describe('exact GCRA state arithmetic', () => {
  it.each([
    identity,
    email,
    { burst: 72, rate: 72, periodSeconds: 60 },
    { burst: 8, rate: 12, periodSeconds: 3600 },
    { burst: 360, rate: 360, periodSeconds: 3600 },
    { burst: 120, rate: 240, periodSeconds: 3600 },
    { burst: 200, rate: 600, periodSeconds: 60 },
  ])('permits exactly the configured idle burst for %j', (policy) => {
    const state = exhaust(policy);
    expect(evaluateGcra(state, policy, 0n).allowed).toBe(false);
    expect(() => chargeGcra(state, policy, 0n)).toThrow(
      'GCRA charge requires eligible state.',
    );
  });

  it('uses exact eligibility boundaries and does not move TAT on repeated evaluation or denial', () => {
    const state = exhaust(identity);
    const original = createGcraState(state.tat, state.policy);
    expect(state.tat).toEqual({ numerator: 60_000_000n, denominator: 1n });
    expect(evaluateGcra(state, identity, 0n).retryAfterSeconds).toBe(10n);
    expect(evaluateGcra(state, identity, 1n).retryAfterSeconds).toBe(10n);
    expect(evaluateGcra(state, identity, 9_000_000n).retryAfterSeconds).toBe(
      1n,
    );
    expect(evaluateGcra(state, identity, 9_999_999n).allowed).toBe(false);
    expect(evaluateGcra(state, identity, 10_000_000n)).toMatchObject({
      allowed: true,
      retryAfterSeconds: 0n,
    });
    expect(state).toEqual(original);
    expect(chargeGcra(state, identity, 10_000_000n).tat).toEqual({
      numerator: 70_000_000n,
      denominator: 1n,
    });
  });

  it('retains 5/6-second IP intervals without rounding each charge', () => {
    const policy = { burst: 72, rate: 72, periodSeconds: 60 };
    const first = chargeGcra(null, policy, 0n);
    expect(first.tat).toEqual({ numerator: 2_500_000n, denominator: 3n });
    const full = exhaust(policy);
    expect(full.tat).toEqual({ numerator: 60_000_000n, denominator: 1n });
    expect(evaluateGcra(full, policy, 833_333n)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 1n,
    });
    expect(evaluateGcra(full, policy, 833_334n).allowed).toBe(true);
    expect(chargeGcra(full, policy, 833_334n).tat).toEqual({
      numerator: 182_500_000n,
      denominator: 3n,
    });
  });

  it('covers the ten-Delivery reference and fractional continued recovery', () => {
    let state: GcraState | null = null;
    for (const seconds of [
      0, 60, 120, 180, 240, 300, 360, 420, 480, 600, 660,
    ]) {
      state = chargeGcra(state, email, BigInt(seconds) * 1_000_000n);
    }
    expect(state!.tat).toEqual({ numerator: 39_600_000_000n, denominator: 7n });
    expect(evaluateGcra(state, email, 720_000_000n)).toMatchObject({
      allowed: false,
      retryAfterSeconds: 309n,
    });
    expect(evaluateGcra(state, email, 1_028_571_428n).allowed).toBe(false);
    expect(evaluateGcra(state, email, 1_028_571_429n).allowed).toBe(true);
    expect(isGcraStateIdle(state!, 1_028_571_429n)).toBe(false);
  });

  it('requires full recovery for cleanup and retains a final fractional microsecond', () => {
    const state = chargeGcra(null, { burst: 1, rate: 3, periodSeconds: 1 }, 0n);
    expect(getGcraIdleAfterMicros(state)).toBe(333_334n);
    expect(isGcraStateIdle(state, 333_333n)).toBe(false);
    expect(isGcraStateIdle(state, 333_334n)).toBe(true);
    expect(chargeGcra(state, state.policy, 1_000_000n).tat).toEqual({
      numerator: 4_000_000n,
      denominator: 3n,
    });
  });

  it('keeps epoch-scale arithmetic, large numerators and retry seconds out of number', () => {
    const now = 1_800_000_000_000_001n;
    const state = chargeGcra(null, email, now);
    expect(state.tat).toEqual({
      numerator: now * 7n + 3_600_000_000n,
      denominator: 7n,
    });
    const large = createGcraState(
      { numerator: 10n ** 90n + 1n, denominator: 7n },
      { burst: 1, rate: 1, periodSeconds: 1 },
    );
    expect(
      evaluateGcra(large, large.policy, 0n).retryAfterSeconds,
    ).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('reduces rational state, snapshots inputs and does not mutate them', () => {
    const policy = { ...identity };
    const tat = { numerator: 6n, denominator: 4n };
    const state = createGcraState(tat, policy);
    policy.burst = 99;
    tat.numerator = 0n;
    expect(state.tat).toEqual({ numerator: 3n, denominator: 2n });
    expect(state.policy).toEqual(identity);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tat)).toBe(true);
    expect(Object.isFrozen(state.policy)).toBe(true);
  });

  it.each([
    { ...identity, burst: 0 },
    { ...identity, rate: 0 },
    { ...identity, periodSeconds: -1 },
    { ...identity, rate: 1.5 },
    { ...identity, burst: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid policy %j', (policy) => {
    expect(() => evaluateGcra(null, policy, 0n)).toThrow(RangeError);
  });

  it.each([
    { numerator: -1n, denominator: 1n },
    { numerator: 1n, denominator: 0n },
    { numerator: 1n, denominator: -1n },
  ])('rejects invalid rational state %p', (tat) => {
    expect(() => createGcraState(tat, identity)).toThrow(RangeError);
  });

  it('rejects negative operation time for every time-based operation', () => {
    const state = exhaust(identity);
    expect(() => evaluateGcra(state, identity, -1n)).toThrow(RangeError);
    expect(() => chargeGcra(state, identity, -1n)).toThrow(RangeError);
    expect(() => isGcraStateIdle(state, -1n)).toThrow(RangeError);
    expect(() => retuneGcraState(state, identity, -1n)).toThrow(RangeError);
  });

  it.each([
    { ...identity, burst: 7 },
    { ...identity, rate: 7 },
    { ...identity, periodSeconds: 61 },
  ])(
    'fails closed on snapshot mismatch instead of silently tuning %j',
    (policy) => {
      const state = exhaust(identity);
      expect(() => evaluateGcra(state, policy, 0n)).toThrow(
        'GCRA policy snapshot mismatch',
      );
      expect(() => chargeGcra(state, policy, 0n)).toThrow(
        'GCRA policy snapshot mismatch',
      );
      expect(() => reconcileGcraStates([state], policy)).toThrow(
        'GCRA policy snapshot mismatch',
      );
    },
  );

  it('reconciles missing and duplicate aliases using latest TAT, never summed debt', () => {
    const early = chargeGcra(null, identity, 0n);
    const late = exhaust(identity);
    expect(reconcileGcraStates([], identity)).toBeNull();
    expect(reconcileGcraStates([late], identity)).toEqual(late);
    expect(reconcileGcraStates([early, late, late], identity)).toEqual(late);
    expect(
      evaluateGcra(reconcileGcraStates([late], identity), identity, 0n).allowed,
    ).toBe(false);
    const first = createGcraState(
      { numerator: 10_000_000n, denominator: 3n },
      identity,
    );
    const second = createGcraState(
      { numerator: 10_000_001n, denominator: 3n },
      identity,
    );
    expect(reconcileGcraStates([second, first], identity)).toEqual(second);
  });

  it('retunes conservatively without issuing new burst or shortening denial', () => {
    const original = exhaust(identity);
    const fasterAndLarger = { burst: 10, rate: 60, periodSeconds: 60 };
    const tuned = retuneGcraState(original, fasterAndLarger, 0n);
    expect(tuned.tat).toEqual({ numerator: 60_000_000n, denominator: 1n });
    expect(evaluateGcra(tuned, fasterAndLarger, 0n).retryAfterSeconds).toBe(
      51n,
    );
    expect(evaluateGcra(original, identity, 0n).retryAfterSeconds).toBe(10n);
    const slower = { ...identity, rate: 3 };
    expect(retuneGcraState(original, slower, 0n).tat).toEqual({
      numerator: 120_000_000n,
      denominator: 1n,
    });
    expect(retuneGcraState(original, identity, 1n)).toEqual(original);
    expect(original.tat.numerator).toBe(60_000_000n);
  });

  it('preserves partial-recovery capacity during burst increases and adopts new policy at idle', () => {
    const original = exhaust(identity);
    const larger = { ...identity, burst: 10 };
    const tuned = retuneGcraState(original, larger, 35_000_000n);
    expect(tuned.tat).toEqual({ numerator: 100_000_000n, denominator: 1n });
    let oldState = original;
    let newState = tuned;
    for (let index = 0; index < 3; index++) {
      oldState = chargeGcra(oldState, identity, 35_000_000n);
      newState = chargeGcra(newState, larger, 35_000_000n);
    }
    expect(evaluateGcra(oldState, identity, 35_000_000n).allowed).toBe(false);
    expect(evaluateGcra(newState, larger, 35_000_000n).allowed).toBe(false);
    const idleTuned = retuneGcraState(original, larger, 60_000_000n);
    expect(idleTuned.tat).toEqual(original.tat);
    expect(idleTuned.policy).toEqual(larger);
  });
});
