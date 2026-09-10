import { parseRetryAfterSeconds } from './parse-retry-after.util';

describe('parseRetryAfterSeconds', () => {
  const operationNow = new Date('2026-09-10T12:00:00.000Z');

  it('parses HTTP delta-seconds', () => {
    expect(parseRetryAfterSeconds({ 'retry-after': '45' }, operationNow)).toBe(
      45,
    );
  });

  it('parses an HTTP-date and rounds up partial seconds', () => {
    expect(
      parseRetryAfterSeconds(
        { 'Retry-After': 'Thu, 10 Sep 2026 12:00:31 GMT' },
        new Date('2026-09-10T12:00:00.500Z'),
      ),
    ).toBe(31);
  });

  it('returns zero for an HTTP-date in the past', () => {
    expect(
      parseRetryAfterSeconds(
        { 'retry-after': 'Thu, 10 Sep 2026 11:59:00 GMT' },
        operationNow,
      ),
    ).toBe(0);
  });

  it.each(['', '-1', '1.5', 'not-a-date', '9007199254740992'])(
    'ignores malformed Retry-After %s',
    (value) => {
      expect(
        parseRetryAfterSeconds({ 'retry-after': value }, operationNow),
      ).toBeUndefined();
    },
  );
});
