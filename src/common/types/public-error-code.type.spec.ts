import {
  PUBLIC_ERROR_CODES,
  VALIDATION_VIOLATION_CODES,
} from './public-error-code.type';

describe('public error-code contract', () => {
  it('contains no duplicate public or validation codes', () => {
    expect(new Set(PUBLIC_ERROR_CODES)).toHaveProperty(
      'size',
      PUBLIC_ERROR_CODES.length,
    );
    expect(new Set(VALIDATION_VIOLATION_CODES)).toHaveProperty(
      'size',
      VALIDATION_VIOLATION_CODES.length,
    );
  });

  it('does not expose deferred authentication feature codes', () => {
    expect(PUBLIC_ERROR_CODES).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/TOTP/),
        expect.stringMatching(/PASSKEY/),
        expect.stringMatching(/OAUTH/),
        expect.stringMatching(/EMAIL_OTP/),
      ]),
    );
  });
});
