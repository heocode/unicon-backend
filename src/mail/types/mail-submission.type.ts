/** Mail infrastructure input. No auth lifecycle, proof or queue ownership. */
export type MailSubmission = Readonly<{
  idempotencyKey: string;
  content: Readonly<{
    recipient: string;
    from: string;
    subject: string;
    html: string;
    text: string;
    inlineAttachments: readonly Readonly<{
      contentId: string;
      filename: string;
      contentType: string;
      content: Uint8Array;
    }>[];
  }>;
}>;
