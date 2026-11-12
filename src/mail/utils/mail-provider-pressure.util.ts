export type MailProviderPressureObservation = Readonly<{
  statusCode: number;
  errorName?: string;
  headers: Readonly<Record<string, string>>;
}>;

const MAX_MICROS = 9_223_372_036_854_775_807n;
export const UTC_DAY_MICROS = 86_400_000_000n;

export function providerRestriction(
  observation: MailProviderPressureObservation,
): 'RATE_LIMIT' | 'DAILY_QUOTA' | 'MONTHLY_QUOTA' | null {
  if (observation.errorName === 'daily_quota_exceeded') return 'DAILY_QUOTA';
  if (observation.errorName === 'monthly_quota_exceeded')
    return 'MONTHLY_QUOTA';
  if (
    observation.statusCode === 429 ||
    observation.errorName === 'rate_limit_exceeded'
  )
    return 'RATE_LIMIT';
  return null;
}

/** Absolute boundary based on fresh database time, never request-start time.
 * Saturate unrepresentable waits to an effectively indefinite fail-closed pause. */
export function retryAfterBoundary(
  headers: Readonly<Record<string, string>>,
  now: bigint,
): bigint | undefined {
  const raw = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === 'retry-after')?.[1]
    .trim();
  if (!raw) return undefined;
  if (/^[0-9]+$/.test(raw)) {
    const digits = raw.replace(/^0+/, '') || '0';
    if (digits.length > 13) return MAX_MICROS;
    const boundary = now + BigInt(digits) * 1_000_000n;
    return boundary > MAX_MICROS ? MAX_MICROS : boundary;
  }
  if (
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(
      raw,
    )
  )
    return undefined;
  const milliseconds = Date.parse(raw);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toUTCString() !== raw
  )
    return undefined;
  const boundary = BigInt(milliseconds) * 1000n;
  return boundary > now ? boundary : now;
}

export function needsProviderPressure(
  observation: MailProviderPressureObservation,
): boolean {
  return (
    providerRestriction(observation) !== null ||
    Object.keys(observation.headers).some(
      (name) => name.toLowerCase() === 'retry-after',
    )
  );
}
