import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
} from '../../src/auth/operations/types/authentication-operation.type';
import type { AuthenticationDeliveryWorkerSummary } from '../../src/auth/delivery/types/authentication-delivery-worker.type';
import type { NewSessionEmail } from '../../src/mail/types/new-session-email.type';
import type { MailWorkResult } from '../../src/mail/types/mail-delivery.type';
import type { AuthenticationOperationTelemetryEvent } from '../../src/auth/operations/types/authentication-operation-telemetry.type';

export type ReplicaCommand =
  | { kind: 'PREPARE'; requests: AuthenticationOperationRequest[] }
  | { kind: 'EXECUTE' }
  | {
      kind: 'EXECUTE_OPERATION';
      operationId: string;
      request: AuthenticationOperationRequest;
    }
  | { kind: 'CLEANUP' }
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

export type ReplicaCleanup = {
  clearedProof: number;
  deletedDelivery: number;
  deletedChallenge: number;
  deletedSubject: number;
  deletedReceipt: number;
};

export type ReplicaReady = {
  pid: number;
  settings: Record<string, number>;
  databaseOid: string;
  configurationProfile?: string;
  keyRotationProfile?: string;
  rateLimitKeyVersions: number[];
  rateLimitActiveVersion: number;
  telemetryFault?: string;
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
  telemetry?: {
    fault: string;
    events: AuthenticationOperationTelemetryEvent[];
  };
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
