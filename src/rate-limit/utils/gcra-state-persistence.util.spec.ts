import { Prisma } from '../../generated/prisma/client';

import { createGcraState } from './gcra-state.util';
import {
  fromGcraPersistenceData,
  toGcraPersistenceData,
} from './gcra-state-persistence.util';

const policy = { burst: 10, rate: 7, periodSeconds: 3600 };

function createStoredState() {
  const state = createGcraState(
    { numerator: 3_600_000_000n, denominator: 7n },
    policy,
  );
  const data = toGcraPersistenceData(state);
  return {
    ...data,
    tatNumerator: new Prisma.Decimal(data.tatNumerator),
    tatDenominator: new Prisma.Decimal(data.tatDenominator),
    idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
  };
}

describe('GCRA persistence conversion', () => {
  it('round-trips integers beyond numeric safety and default Decimal precision', () => {
    const state = createGcraState(
      { numerator: 10n ** 90n + 1n, denominator: 7n },
      policy,
    );
    const data = toGcraPersistenceData(state);
    const restored = fromGcraPersistenceData({
      ...data,
      tatNumerator: new Prisma.Decimal(data.tatNumerator),
      tatDenominator: new Prisma.Decimal(data.tatDenominator),
      idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
    });
    expect(restored).toEqual(state);
    expect(data.burst).toBe(10n);
    expect(data.tatNumerator).toBe(state.tat.numerator.toString());
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1.5'])(
    'rejects persisted noninteger/nonfinite time %s',
    (value) => {
      const stored = createStoredState();
      for (const field of [
        'tatNumerator',
        'tatDenominator',
        'idleAfterMicros',
      ] as const) {
        expect(() =>
          fromGcraPersistenceData({
            ...stored,
            [field]: new Prisma.Decimal(value),
          }),
        ).toThrow('Persisted GCRA time must contain finite integers.');
      }
    },
  );

  it.each([0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
    'rejects unsafe persisted policy value %s',
    (value) => {
      const stored = createStoredState();
      for (const field of ['burst', 'rate', 'periodSeconds'] as const) {
        expect(() =>
          fromGcraPersistenceData({ ...stored, [field]: value }),
        ).toThrow(
          'Persisted GCRA policy values must be positive safe integers.',
        );
      }
    },
  );

  it('rejects invalid rational signs and an inconsistent recovery boundary', () => {
    const stored = createStoredState();
    expect(() =>
      fromGcraPersistenceData({
        ...stored,
        tatDenominator: new Prisma.Decimal(0),
      }),
    ).toThrow(RangeError);
    expect(() =>
      fromGcraPersistenceData({
        ...stored,
        tatNumerator: new Prisma.Decimal(-1),
      }),
    ).toThrow(RangeError);
    expect(() =>
      fromGcraPersistenceData({
        ...stored,
        idleAfterMicros: new Prisma.Decimal(0),
      }),
    ).toThrow('Persisted GCRA full-recovery boundary is inconsistent.');
  });
});
