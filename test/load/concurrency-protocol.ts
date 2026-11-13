import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
} from '../../src/auth/operations/types/authentication-operation.type';
import type { AuthenticationDeliveryWorkerSummary } from '../../src/auth/delivery/types/authentication-delivery-worker.type';

export type ReplicaCommand =
  | { kind: 'PREPARE'; requests: AuthenticationOperationRequest[] }
  | { kind: 'EXECUTE' }
  | { kind: 'START_WORKER' }
  | { kind: 'STOP' };

export type ReplicaExecution = {
  operationId: string;
  response?: AuthenticationOperationResponse;
  error?: string;
  elapsedMs: number;
};

export type ReplicaReady = { pid: number; settings: Record<string, number> };
export type ReplicaWorkerStarted = {
  summary: AuthenticationDeliveryWorkerSummary;
};
export type ReplicaStopped = {
  grants: { now: bigint; next: bigint }[];
  deferredCount: number;
};
export type ReplicaReply = { id: number; ok: boolean; data?: unknown };
