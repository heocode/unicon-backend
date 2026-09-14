// NestJS
import { Injectable } from '@nestjs/common';

// Internal services
import { AuthenticationEmailAssetService } from '../../../mail/services/authentication-email-asset.service';
import { AuthenticationMagicLinkService } from './authentication-magic-link.service';

// Internal constants
import {
  AUTHENTICATION_EMAIL_FROM,
  AUTHENTICATION_EMAIL_LOGO_V1_CONTENT_ID,
  AUTHENTICATION_EMAIL_LOGO_V1_CONTENT_TYPE,
  AUTHENTICATION_EMAIL_LOGO_V1_FILENAME,
  AUTHENTICATION_EMAIL_TEMPLATE_PROTOCOL_VERSION,
} from '../../../config/constants/authentication-email.constants';

// Internal types
import type { AuthenticationEmailContent } from '../types/authentication-email-provider.type';

// Internal utilities
import { parseCanonicalOtp } from '../../challenge/utils/parse-canonical-challenge-proof.util';

export type RenderAuthenticationEmailInput = Readonly<{
  templateProtocolVersion: number;
  recipient: string;
  otp: string;
  magicLinkUrl: string;
}>;

@Injectable()
export class AuthenticationEmailTemplateService {
  constructor(
    private readonly assetService: AuthenticationEmailAssetService,
    private readonly magicLinkService: AuthenticationMagicLinkService,
  ) {}

  render(input: RenderAuthenticationEmailInput): AuthenticationEmailContent {
    if (
      input.templateProtocolVersion !==
      AUTHENTICATION_EMAIL_TEMPLATE_PROTOCOL_VERSION
    ) {
      throw new Error('Authentication email template protocol is unsupported.');
    }

    parseCanonicalOtp(input.otp);
    this.magicLinkService.assertCanonicalVerificationUrl(input.magicLinkUrl);

    return this.renderV1(input);
  }

  private renderV1(
    input: RenderAuthenticationEmailInput,
  ): AuthenticationEmailContent {
    const displayOtp = input.otp.split('').join(' ');
    const htmlMagicLink = input.magicLinkUrl.replace('&', '&amp;');

    return {
      recipient: input.recipient,
      from: AUTHENTICATION_EMAIL_FROM,
      subject: `${input.otp} — Your Unicon sign-in code`,
      html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Sign in to Unicon</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#ffffff;">
    <tr>
      <td align="center" style="padding:40px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;">
          <tr><td align="center" style="padding:40px 0 22px;"><img src="cid:${AUTHENTICATION_EMAIL_LOGO_V1_CONTENT_ID}" width="144" height="144" alt="Unicon" style="display:block;width:144px;height:144px;border:0;outline:none;text-decoration:none;"></td></tr>
          <tr><td align="center" style="padding:0 24px;font-size:28px;line-height:34px;font-weight:700;color:#111827;">Sign in to Unicon</td></tr>
          <tr><td align="center" style="padding:28px 24px 15px;font-size:18px;line-height:24px;color:#000000;">Use this code to continue:</td></tr>
          <tr><td align="center" style="padding:0 24px;">
            <table role="presentation" width="366" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:366px;background:#c4cede;border:2px solid #d7deea;border-radius:18px;">
              <tr><td align="center" style="padding:12px 14px;font-size:32px;line-height:38px;font-weight:700;letter-spacing:12px;color:#15418a;white-space:nowrap;">${displayOtp}</td></tr>
            </table>
          </td></tr>
          <tr><td align="center" style="padding:19px 24px;">
            <table role="presentation" width="270" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:270px;"><tr>
              <td style="height:1px;background:#15418a;font-size:0;line-height:0;">&nbsp;</td>
              <td width="32" align="center" style="font-size:14px;line-height:18px;color:#15418a;">or</td>
              <td style="height:1px;background:#15418a;font-size:0;line-height:0;">&nbsp;</td>
            </tr></table>
          </td></tr>
          <tr><td align="center" style="padding:0 24px;"><a href="${htmlMagicLink}" style="display:block;width:100%;max-width:366px;box-sizing:border-box;padding:17px 24px;border-radius:39px;background:#15418a;color:#ffffff;font-size:18px;line-height:22px;font-weight:700;text-align:center;text-decoration:none;">Open Unicon</a></td></tr>
          <tr><td align="center" style="padding:88px 24px 18px;font-size:18px;line-height:24px;color:#000000;">This code and link expire 10 minutes after your sign-in request.</td></tr>
          <tr><td style="height:2px;background:#15418a;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td align="center" style="padding:15px 24px 0;font-size:16px;line-height:19px;font-weight:700;color:#000000;">If you didn&rsquo;t request this email,<br>you can safely ignore it.</td></tr>
          <tr><td align="center" style="padding:10px 24px 38px;font-size:16px;line-height:20px;font-weight:700;color:#f4a93b;">&copy; Unicon</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
      text: `Sign in to Unicon

Use this code to continue:
${input.otp}

Or open Unicon:
${input.magicLinkUrl}

This code and link expire 10 minutes after your sign-in request.

If you didn't request this email, you can safely ignore it.

© Unicon`,
      inlineAttachments: [
        {
          contentId: AUTHENTICATION_EMAIL_LOGO_V1_CONTENT_ID,
          filename: AUTHENTICATION_EMAIL_LOGO_V1_FILENAME,
          contentType: AUTHENTICATION_EMAIL_LOGO_V1_CONTENT_TYPE,
          content: this.assetService.getLogoV1(),
        },
      ],
    };
  }
}
