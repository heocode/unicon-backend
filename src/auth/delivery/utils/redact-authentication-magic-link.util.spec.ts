import { redactAuthenticationMagicLink } from './redact-authentication-magic-link.util';

describe('redactAuthenticationMagicLink', () => {
  const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

  it('retains structured identity metadata but removes the proof', () => {
    const redacted = redactAuthenticationMagicLink(
      `https://uniconnection.app/auth/verify?challengeId=123e4567-e89b-42d3-a456-426614174000&token=${token}`,
    );

    expect(redacted).toBe(
      'https://uniconnection.app/auth/verify?challengeId=123e4567-e89b-42d3-a456-426614174000&token=[REDACTED]',
    );
    expect(redacted).not.toContain(token);
  });

  it.each([
    `https://attacker.example/auth/verify?token=${token}`,
    `not-a-url-containing-${token}`,
    `https://uniconnection.app/auth/verify?challengeId=${token}&token=another-secret`,
  ])('fails closed without returning sensitive input %s', (value) => {
    const redacted = redactAuthenticationMagicLink(value);

    expect(redacted).toBe('[REDACTED_AUTH_MAGIC_LINK]');
    expect(redacted).not.toContain(token);
  });
});
