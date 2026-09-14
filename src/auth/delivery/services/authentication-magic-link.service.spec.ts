import { ConfigService } from '@nestjs/config';

import { AuthenticationMagicLinkService } from './authentication-magic-link.service';

describe('AuthenticationMagicLinkService', () => {
  const challengeId = '123e4567-e89b-42d3-a456-426614174000';
  const linkToken = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const configService = {
    getOrThrow: jest.fn(() => 'https://uniconnection.app/auth/verify'),
  };

  it('locks the exact client-neutral authentication intent URL contract', () => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );

    expect(service.buildVerificationUrl({ challengeId, linkToken })).toBe(
      'https://uniconnection.app/auth/verify?challengeId=123e4567-e89b-42d3-a456-426614174000&token=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    );
  });

  it('builds deterministically without dynamic or client-specific parameters', () => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );

    const first = service.buildVerificationUrl({ challengeId, linkToken });
    const second = service.buildVerificationUrl({ challengeId, linkToken });
    const url = new URL(first);

    expect(second).toBe(first);
    expect([...url.searchParams.keys()]).toEqual(['challengeId', 'token']);
    expect([...url.searchParams]).toHaveLength(2);
  });

  it.each([
    '123E4567-E89B-42D3-A456-426614174000',
    '123e4567e89b42d3a456426614174000',
    'not-a-uuid',
  ])('delegates rejection of non-canonical challenge ID %s', (candidate) => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );

    expect(() =>
      service.buildVerificationUrl({
        challengeId: candidate,
        linkToken,
      }),
    ).toThrow('UUID must use its canonical representation.');
  });

  it.each([
    `${linkToken}=`,
    linkToken.slice(1),
    `${linkToken.slice(0, -1)}+`,
    `${linkToken.slice(0, -1)} `,
  ])('delegates rejection of non-canonical magic token %s', (candidate) => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );

    expect(() =>
      service.buildVerificationUrl({
        challengeId,
        linkToken: candidate,
      }),
    ).toThrow('Magic-link token must use its canonical representation.');
  });

  it('does not disclose rejected input in an error', () => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );
    const secretCandidate = `secret-${linkToken}`;

    try {
      service.buildVerificationUrl({
        challengeId,
        linkToken: secretCandidate,
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(secretCandidate);
    }
  });

  it('fails closed if constructed outside validated startup configuration', () => {
    const invalidConfigService = {
      getOrThrow: jest.fn(() => 'https://uniconnection.app/auth/verify/'),
    };

    expect(
      () =>
        new AuthenticationMagicLinkService(
          invalidConfigService as unknown as ConfigService,
        ),
    ).toThrow('Authentication magic-link configuration is invalid.');
  });

  it('only constructs a GET intent URL and has no proof verification side effect', () => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );

    expect(() =>
      service.buildVerificationUrl({ challengeId, linkToken }),
    ).not.toThrow();
    expect(configService.getOrThrow).toHaveBeenCalledWith(
      'AUTH_MAGIC_LINK_PUBLIC_URL',
    );
  });

  it('accepts only the exact canonical verification URL', () => {
    const service = new AuthenticationMagicLinkService(
      configService as unknown as ConfigService,
    );
    const canonical = service.buildVerificationUrl({ challengeId, linkToken });

    expect(() =>
      service.assertCanonicalVerificationUrl(canonical),
    ).not.toThrow();
    expect(() =>
      service.assertCanonicalVerificationUrl(`${canonical}&source=email`),
    ).toThrow('Authentication magic-link URL is not canonical.');
    expect(() =>
      service.assertCanonicalVerificationUrl(
        canonical.replace('&token=', '&token=%'),
      ),
    ).toThrow('Authentication magic-link URL is not canonical.');
  });
});
