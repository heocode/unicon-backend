import type {
  NotificationDelivery,
  NotificationType,
  Prisma,
} from '../../generated/prisma/client';
import type { MailSubmission } from './mail-submission.type';

export type MailDeliveryContext = {
  userId?: string;
  sessionId?: string | null;
};
export type MailProofGuard =
  | { kind: 'VERIFICATION'; userId: string; tokenHash: string }
  | {
      kind: 'PASSWORD_RESET';
      tokenId: string;
      userId: string;
      tokenHash: string;
    };
export type StoredMailPayload = {
  content: MailSubmission['content'];
  guard?: MailProofGuard;
};
export type MailEnvelopeContext = Pick<
  NotificationDelivery,
  'id' | 'idempotencyKey' | 'recipient' | 'type'
> & { mailExpiresAt: Date };
export type QueueMailInput = MailDeliveryContext & {
  type: NotificationType;
  idempotencyKey: string;
  content: {
    from: string;
    recipient: string;
    subject: string;
    text?: string;
    html?: string;
  };
  guard?: MailProofGuard;
};
export type MailTransaction = Prisma.TransactionClient;
export type MailWorkResult = {
  outcome: 'SENT' | 'FAILED' | 'RETRY_SCHEDULED' | 'DEFERRED' | 'LEASE_LOST';
  retryNotBeforeMicros?: bigint;
};
