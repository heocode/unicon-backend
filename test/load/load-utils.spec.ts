import { boundedInteger, distribution, offerLoad } from './load-utils';

describe('Smoke measurement helpers', () => {
  it('rejects unbounded and malformed load settings', () => {
    for (const value of ['0', '-1', '1.5', 'Infinity', '21', 'bad'])
      expect(() => boundedInteger(value, 2, 20)).toThrow();
    expect(boundedInteger(undefined, 2, 20)).toBe(2);
  });

  it('reports empty samples and nearest-rank percentiles explicitly', () => {
    expect(distribution([])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    });
    expect(distribution([100, 1, 3, 2]).p95).toBe(100);
  });

  it('offers arrivals before earlier operations finish and counts rejections', async () => {
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const starts: number[] = [];
    const result = await offerLoad(100, 3, async (index) => {
      starts.push(index);
      if (index === 0) await held;
      if (index === 2) {
        finish();
        throw new Error('Expected synthetic failure.');
      }
    });
    expect(starts).toEqual([0, 1, 2]);
    expect(result.rejectedOperations).toBe(1);
    expect(result.schedulingLagMs.count).toBe(3);
  });
});
