import {
  parseCanonicalMagicLinkToken,
  parseCanonicalOtp,
} from './parse-canonical-challenge-proof.util';

describe('canonical challenge proof parsing', () => {
  describe('parseCanonicalOtp', () => {
    it('returns the six OTP digits as ASCII bytes', () => {
      expect(parseCanonicalOtp('004201')).toEqual(Buffer.from('004201'));
    });

    it.each(['4201', '0000000', '12 345', '１２３４５６', 'abcdef'])(
      'rejects non-canonical OTP %s',
      (otp) => {
        expect(() => parseCanonicalOtp(otp)).toThrow(
          'OTP must use its canonical representation.',
        );
      },
    );
  });

  describe('parseCanonicalMagicLinkToken', () => {
    const secret = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const token = secret.toString('base64url');

    it('returns the original 32 secret bytes', () => {
      expect(token).toHaveLength(43);
      expect(parseCanonicalMagicLinkToken(token)).toEqual(secret);
    });

    it.each([
      `${token}=`,
      token.slice(1),
      `${token.slice(0, -1)}+`,
      `${token.slice(0, -1)}/`,
      `${token.slice(0, -1)} `,
    ])('rejects non-canonical magic-link token %s', (candidate) => {
      expect(() => parseCanonicalMagicLinkToken(candidate)).toThrow(
        'Magic-link token must use its canonical representation.',
      );
    });
  });
});
