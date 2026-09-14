// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { AuthenticationEmailSubmission } from '../../auth/delivery/types/authentication-email-provider.type';

export type ResendAuthenticationEmailTransportResponse =
  | Readonly<{
      outcome: 'ACCEPTED';
      providerMessageId?: string;
      headers: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      outcome: 'REJECTED';
      errorName?: string;
      statusCode: number;
      headers: Readonly<Record<string, string>>;
    }>;

@Injectable()
export class ResendAuthenticationEmailTransportService {
  private readonly apiKey: string;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('RESEND_API_KEY');
  }

  async send(
    submission: AuthenticationEmailSubmission,
    signal: AbortSignal,
  ): Promise<ResendAuthenticationEmailTransportResponse> {
    const { content } = submission;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': submission.idempotencyKey,
      },
      body: JSON.stringify({
        from: content.from,
        to: [content.recipient],
        subject: content.subject,
        html: content.html,
        text: content.text,
        attachments: content.inlineAttachments.map((attachment) => ({
          content: Buffer.from(attachment.content).toString('base64'),
          filename: attachment.filename,
          content_type: attachment.contentType,
          content_id: attachment.contentId,
        })),
      }),
      signal,
    });
    const headers = Object.fromEntries(response.headers.entries());
    const body = await this.parseResponseBody(response);

    if (response.ok) {
      return {
        outcome: 'ACCEPTED',
        ...(typeof body?.id === 'string' ? { providerMessageId: body.id } : {}),
        headers,
      };
    }

    return {
      outcome: 'REJECTED',
      ...(typeof body?.name === 'string' ? { errorName: body.name } : {}),
      statusCode: response.status,
      headers,
    };
  }

  private async parseResponseBody(
    response: Response,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const body: unknown = await response.json();

      return body !== null && typeof body === 'object'
        ? (body as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
