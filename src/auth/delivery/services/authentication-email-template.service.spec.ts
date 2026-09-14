// Node.js
import { createHash } from 'node:crypto';

// Internal services
import { AuthenticationEmailAssetService } from '../../../mail/services/authentication-email-asset.service';
import { AuthenticationEmailTemplateService } from './authentication-email-template.service';
import { AuthenticationMagicLinkService } from './authentication-magic-link.service';

describe('AuthenticationEmailTemplateService', () => {
  const otp = '482731';
  const magicLinkUrl =
    'https://uniconnection.app/auth/verify?challengeId=123e4567-e89b-42d3-a456-426614174000&token=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const logo = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const assetService = { getLogoV1: jest.fn(() => Uint8Array.from(logo)) };
  const magicLinkService = {
    assertCanonicalVerificationUrl: jest.fn(),
  };
  let service: AuthenticationEmailTemplateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthenticationEmailTemplateService(
      assetService as unknown as AuthenticationEmailAssetService,
      magicLinkService as unknown as AuthenticationMagicLinkService,
    );
  });

  it('renders the deterministic template v1 and CID attachment contract', () => {
    const first = service.render({
      templateProtocolVersion: 1,
      recipient: 'student@example.edu',
      otp,
      magicLinkUrl,
    });
    const second = service.render({
      templateProtocolVersion: 1,
      recipient: 'student@example.edu',
      otp,
      magicLinkUrl,
    });

    expect(first).toEqual(second);
    expect(first.subject).toBe('482731 — Your Unicon sign-in code');
    expect(first.from).toBe('Unicon <noreply@uniconnection.app>');
    expect(first.html).toContain('cid:unicon-logo-v1');
    expect(first.html).toContain('4 8 2 7 3 1');
    expect(first.html).toContain(
      'This code and link expire 10 minutes after your sign-in request.',
    );
    expect(first.html).toContain(magicLinkUrl.replace('&', '&amp;'));
    expect(first.text).toContain(magicLinkUrl);
    expect(first.inlineAttachments).toEqual([
      {
        contentId: 'unicon-logo-v1',
        filename: 'unicon-logo-v1.png',
        contentType: 'image/png',
        content: logo,
      },
    ]);
    expect(JSON.stringify(first)).not.toContain('deliveryId');
    expect(JSON.stringify(first)).not.toContain('idempotencyKey');
    expect(first.html).not.toMatch(/https?:\/\/[^"']+\.(?:png|svg)/);
    expect(first.html).not.toContain('tracking');
    expect(createHash('sha256').update(first.html).digest('hex')).toBe(
      '95ff84e34d55e31a62c2ab09e93e2f5f0469f56a97c2f4711236bf46dcd57773',
    );
    expect(createHash('sha256').update(first.text).digest('hex')).toBe(
      '83981e52c37d6e752ac0429ee0e44311c9901e79d7bbab40bf455a11339351ab',
    );
  });

  it('rejects unsupported templates before touching proof inputs', () => {
    expect(() =>
      service.render({
        templateProtocolVersion: 2,
        recipient: 'student@example.edu',
        otp,
        magicLinkUrl,
      }),
    ).toThrow('Authentication email template protocol is unsupported.');
    expect(
      magicLinkService.assertCanonicalVerificationUrl,
    ).not.toHaveBeenCalled();
  });

  it.each(['12345', '1234567', '12 345', 'abcdef'])(
    'rejects non-canonical OTP %s',
    (candidate) => {
      expect(() =>
        service.render({
          templateProtocolVersion: 1,
          recipient: 'student@example.edu',
          otp: candidate,
          magicLinkUrl,
        }),
      ).toThrow('OTP must use its canonical representation.');
    },
  );

  it('delegates canonical magic-link validation without disclosing its value', () => {
    magicLinkService.assertCanonicalVerificationUrl.mockImplementation(() => {
      throw new Error('Authentication magic-link URL is not canonical.');
    });

    expect(() =>
      service.render({
        templateProtocolVersion: 1,
        recipient: 'student@example.edu',
        otp,
        magicLinkUrl: 'https://example.com/private-token',
      }),
    ).toThrow('Authentication magic-link URL is not canonical.');
  });
});
