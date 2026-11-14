import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
} from '../../src/auth/operations/types/authentication-operation.type';
import type { AuthenticationDeliveryWorkerSummary } from '../../src/auth/delivery/types/authentication-delivery-worker.type';
import type { NewSessionEmail } from '../../src/mail/types/new-session-email.type';
import type { MailWorkResult } from '../../src/mail/types/mail-delivery.type';

export type ReplicaCommand =
  | { kind: 'PREPARE'; requests: AuthenticationOperationRequest[] }
  | { kind: 'EXECUTE' }
  | { kind: 'START_WORKER' }
  | { kind: 'ENQUEUE_NOTIFICATIONS'; notifications: NewSessionEmail[] }
  | { kind: 'START_MIXED_WORKERS' }
  | { kind: 'STOP' };

export type ReplicaExecution = {
  operationId: string;
  response?: AuthenticationOperationResponse;
  error?: string;
  elapsedMs: number;
};

export type ReplicaReady = {
  pid: number;
  settings: Record<string, number>;
  databaseOid: string;
  databaseLifecycle: {
    runId: string;
    stateMode: 'isolated' | 'retained';
    initialState: string;
  };
};
export type ReplicaWorkerStarted = {
  summary: AuthenticationDeliveryWorkerSummary;
};
export type ReplicaStopped = {
  grants: { now: bigint; next: bigint }[];
  deferredCount: number;
  deferrals?: {
    auth: DeferralObservations;
    notifications: DeferralObservations;
  };
};
export type DeferralObservations = {
  transitions: number;
  snapshots: number;
  racedReads: number;
  invalidSnapshots: number;
  readErrors: number;
};
export type ReplicaMixedStarted = ReplicaWorkerStarted & {
  notifications: readonly MailWorkResult[];
};
export type ReplicaReply = { id: number; ok: boolean; data?: unknown };
