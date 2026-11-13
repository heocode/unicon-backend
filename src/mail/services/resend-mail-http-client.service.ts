// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { MailSubmission } from '../types/mail-submission.type';

export type ResendMailHttpResponse =
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
export class ResendMailHttpClient {
  protected readonly endpoint: string = 'https://api.resend.com/emails';
  private readonly apiKey: string;

  constructor(configService: ConfigService) {
    this.apiKey = configService.getOrThrow<string>('RESEND_API_KEY');
  }

  async send(
    submission: MailSubmission,
    signal: AbortSignal,
  ): Promise<ResendMailHttpResponse> {
    const { content } = submission;
    const response = await fetch(this.endpoint, {
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
        ...(content.html ? { html: content.html } : {}),
        ...(content.text ? { text: content.text } : {}),
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
