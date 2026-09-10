export type AuthenticationEmailContent = Readonly<{
  recipient: string;
  from: string;
  subject: string;
  html: string;
  text: string;
}>;

export type AuthenticationEmailSubmission = Readonly<{
  content: AuthenticationEmailContent;
  deliveryId: string;
  idempotencyKey: string;
  templateProtocolVersion: number;
}>;

export enum AuthenticationEmailRetryKind {
  SAFE_RETRY = 'SAFE_RETRY',
  AMBIGUOUS_RETRY = 'AMBIGUOUS_RETRY',
}

export enum AuthenticationEmailPermanentFailureReason {
  RECIPIENT = 'RECIPIENT',
  INVALID_REQUEST = 'INVALID_REQUEST',
  CONFIGURATION = 'CONFIGURATION',
  PROVIDER_AUTHENTICATION = 'PROVIDER_AUTHENTICATION',
}

export type AuthenticationEmailProviderResult =
  | Readonly<{
      outcome: 'ACCEPTED';
      providerMessageId?: string;
    }>
  | Readonly<{
      outcome: 'RETRYABLE';
      retryKind: AuthenticationEmailRetryKind;
      safeFailureCode: string;
      retryAfterSeconds?: number;
    }>
  | Readonly<{
      outcome: 'PERMANENT_FAILURE';
      reason: AuthenticationEmailPermanentFailureReason;
      safeFailureCode: string;
    }>;
