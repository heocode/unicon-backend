import { ConfigService } from '@nestjs/config';

import type { AuthenticationEmailSubmission } from '../../auth/delivery/types/authentication-email-provider.type';
import { ResendAuthenticationEmailTransportService } from './resend-authentication-email-transport.service';

describe('ResendAuthenticationEmailTransportService', () => {
  const submission: AuthenticationEmailSubmission = {
    content: {
      recipient: 'student@example.edu',
      from: 'Unicon <noreply@uniconnection.app>',
      subject: '482731 — Your Unicon sign-in code',
      html: '<p>html</p>',
      text: 'text',
      inlineAttachments: [
        {
          contentId: 'unicon-logo-v1',
          filename: 'unicon-logo-v1.png',
          contentType: 'image/png',
          content: Uint8Array.from([0, 1, 2, 255]),
        },
      ],
    },
    deliveryId: 'internal-delivery-id',
    idempotencyKey: 'stable-idempotency-key',
    templateProtocolVersion: 1,
  };
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  let service: ResendAuthenticationEmailTransportService;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
    service = new ResendAuthenticationEmailTransportService({
      getOrThrow: jest.fn(() => 'test-api-key'),
    } as unknown as ConfigService);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('submits only email content plus the stable idempotency key', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: 'provider-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const abortController = new AbortController();

    await expect(
      service.send(submission, abortController.signal),
    ).resolves.toMatchObject({
      outcome: 'ACCEPTED',
      providerMessageId: 'provider-id',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'stable-idempotency-key',
      },
      body: JSON.stringify({
        from: submission.content.from,
        to: [submission.content.recipient],
        subject: submission.content.subject,
        html: submission.content.html,
        text: submission.content.text,
        attachments: [
          {
            content: 'AAEC/w==',
            filename: 'unicon-logo-v1.png',
            content_type: 'image/png',
            content_id: 'unicon-logo-v1',
          },
        ],
      }),
      signal: abortController.signal,
    });
  });

  it('retains only provider classification fields from a rejected response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: 'rate_limit_exceeded',
          message: 'raw provider detail',
        }),
        { status: 429, headers: { 'retry-after': '5' } },
      ),
    );

    const result = await service.send(submission, new AbortController().signal);

    expect(result).toEqual({
      outcome: 'REJECTED',
      errorName: 'rate_limit_exceeded',
      statusCode: 429,
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'retry-after': '5',
      },
    });
    expect(JSON.stringify(result)).not.toContain('raw provider detail');
  });
});
