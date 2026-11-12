import {
  needsProviderPressure,
  providerRestriction,
  retryAfterBoundary,
  UTC_DAY_MICROS,
} from './mail-provider-pressure.util';

describe('Mail provider pressure boundaries', () => {
  const now =
    BigInt(Date.parse('Thu, 12 Nov 2026 12:00:00 GMT')) * 1000n + 123456n;
  it('keeps exact numeric wait relative to response observation, including zero', () => {
    expect(retryAfterBoundary({ 'Retry-After': '2' }, now)).toBe(
      now + 2_000_000n,
    );
    expect(retryAfterBoundary({ 'retry-after': '0' }, now)).toBe(now);
  });
  it('uses an absolute HTTP date without extending it by fractional seconds', () => {
    expect(
      retryAfterBoundary(
        { 'retry-after': 'Thu, 12 Nov 2026 12:01:00 GMT' },
        now,
      ),
    ).toBe(now - 123456n + 60_000_000n);
    expect(
      retryAfterBoundary(
        { 'retry-after': 'Thu, 12 Nov 2026 11:00:00 GMT' },
        now,
      ),
    ).toBe(now);
  });
  it.each([
    '',
    '-1',
    '0.5',
    'Infinity',
    'tomorrow',
    'Thu, 31 Feb 2026 12:01:00 GMT',
    'Fri, 12 Nov 2026 12:01:00 GMT',
  ])('rejects invalid Retry-After %s', (value) => {
    expect(retryAfterBoundary({ 'retry-after': value }, now)).toBeUndefined();
  });
  it('saturates oversized valid waits instead of treating them as a short fallback', () => {
    expect(retryAfterBoundary({ 'retry-after': '9'.repeat(100) }, now)).toBe(
      9223372036854775807n,
    );
    expect(retryAfterBoundary({ 'retry-after': '9999999999999' }, now)).toBe(
      9223372036854775807n,
    );
  });
  it('classifies quota names before the generic 429 status', () => {
    expect(
      providerRestriction({
        statusCode: 429,
        errorName: 'daily_quota_exceeded',
        headers: {},
      }),
    ).toBe('DAILY_QUOTA');
    expect(
      providerRestriction({
        statusCode: 429,
        errorName: 'monthly_quota_exceeded',
        headers: {},
      }),
    ).toBe('MONTHLY_QUOTA');
    expect(providerRestriction({ statusCode: 429, headers: {} })).toBe(
      'RATE_LIMIT',
    );
    expect(providerRestriction({ statusCode: 500, headers: {} })).toBeNull();
  });
  it('records Retry-After even on success; ignores unrelated responses', () => {
    expect(
      needsProviderPressure({
        statusCode: 200,
        headers: { 'Retry-After': '2' },
      }),
    ).toBe(true);
    expect(needsProviderPressure({ statusCode: 200, headers: {} })).toBe(false);
  });
  it('UTC midnight uses the next calendar boundary, not a rolling 24 hours', () => {
    const midnight = (now / UTC_DAY_MICROS + 1n) * UTC_DAY_MICROS;
    expect(midnight).toBe(
      BigInt(Date.parse('Fri, 13 Nov 2026 00:00:00 GMT')) * 1000n,
    );
  });
});
