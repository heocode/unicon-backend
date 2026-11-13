import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
    throw new Error('Invalid bounded smoke load setting.');
  return parsed;
}

export function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}

/** Fixed arrivals, independent of completions; all scheduled work is accounted. */
export async function offerLoad(
  rate: number,
  count: number,
  operation: (index: number, started: number) => Promise<void>,
) {
  const start = performance.now();
  const lag: number[] = [];
  const pending: Promise<boolean>[] = [];
  for (let index = 0; index < count; index++) {
    const due = start + (index * 1000) / rate;
    await delay(Math.max(0, due - performance.now()));
    const started = performance.now();
    lag.push(Math.max(0, started - due));
    pending.push(
      operation(index, started).then(
        () => true,
        () => false,
      ),
    );
  }
  const launchSpanMs = performance.now() - start;
  const settled = await Promise.all(pending);
  return {
    launchSpanMs,
    schedulingLagMs: distribution(lag),
    rejectedOperations: settled.filter((success) => !success).length,
  };
}
