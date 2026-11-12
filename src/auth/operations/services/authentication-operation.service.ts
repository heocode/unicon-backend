import { Injectable } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import {
  Prisma,
  type AuthenticationOperation,
} from '../../../generated/prisma/client';

import { assertCanonicalUuid } from '../../../common/utils/assert-canonical-uuid.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { GcraAdmissionConfigService } from '../../../rate-limit/services/gcra-admission-config.service';
import { isRetryableGcraTransactionError } from '../../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { AuthenticationChallengeRequestService } from '../../challenge/services/authentication-challenge-request.service';
import type { AuthenticationSignInRequestResult } from '../../challenge/types/authentication-challenge-request.type';
import { AuthenticationDeliveryAdmissionService } from '../../delivery/services/authentication-delivery-admission.service';
import type { AuthenticationResendAdmissionResult } from '../../delivery/types/authentication-delivery-admission.type';
import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../../rate-limit/constants/authentication-global-delivery-admission.constants';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../../rate-limit/constants/authentication-rate-limit-policies.constants';
import { AuthenticationOperationError } from '../errors/authentication-operation.error';
import { AuthenticationOperationRepository } from '../repositories/authentication-operation.repository';
import type {
  AuthenticationOperationRequest,
  AuthenticationOperationResponse,
  AuthenticationOperationReconciliation,
} from '../types/authentication-operation.type';
import {
  createAuthenticationOperationId,
  authenticationOperationWindow,
  assertAuthenticationOperationActive,
} from '../utils/authentication-operation-id.util';
import { captureAuthenticationOperation } from '../utils/authentication-operation-request.util';

type CapturedOperation = ReturnType<typeof captureAuthenticationOperation>;

@Injectable()
export class AuthenticationOperationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AuthenticationOperationRepository,
    private readonly requests: AuthenticationChallengeRequestService,
    private readonly deliveries: AuthenticationDeliveryAdmissionService,
    private readonly bounds: GcraAdmissionConfigService,
  ) {}

  /** Mint once, before execution/retries; this identifier is not a credential. */
  async createOperationId(): Promise<string> {
    try {
      return createAuthenticationOperationId(await this.repository.nowMicros());
    } catch {
      throw new AuthenticationOperationError('STATE_UNAVAILABLE');
    }
  }

  async execute(
    id: string,
    request: AuthenticationOperationRequest,
  ): Promise<AuthenticationOperationResponse> {
    const captured = captureAuthenticationOperation(id, request);
    const providerKey = randomUUID(); // Separate from operation identity, stable across confirmed-abort retries.
    for (let attempt = 1; attempt <= this.bounds.maxAttempts; attempt++) {
      let callbackCompleted = false;
      try {
        return await this.transaction(async (tx) => {
          const previous = await this.resolveLocked(tx, id, captured);
          if (previous) {
            callbackCompleted = true;
            return previous;
          }
          const raw =
            captured.request.kind === 'SIGN_IN_REQUEST'
              ? await this.requests.requestSignInInTransaction(tx, {
                  ...captured.request.input,
                  idempotencyKey: providerKey,
                })
              : await this.deliveries.admitResendInTransaction(tx, {
                  ...captured.request.input,
                  idempotencyKey: providerKey,
                });
          const now = await this.repository.nowMicros(tx);
          assertAuthenticationOperationActive(id, now); // Includes all downstream lock waits; expiry rolls back new work.
          const row = await this.repository.insert(
            tx,
            this.receipt(id, captured, raw, now),
          );
          const response = this.response(row, captured, now, false);
          callbackCompleted = true;
          return response;
        });
      } catch (error) {
        if (isRetryableGcraTransactionError(error)) {
          if (attempt < this.bounds.maxAttempts) continue;
          throw new AuthenticationOperationError('RETRY_EXHAUSTED');
        }
        if (callbackCompleted) {
          // A fresh primary-DB transaction waits for the original operation lock.
          // Read-only reconciliation never invokes admission or refunds charges.
          const reconciled = await this.reconcileCaptured(id, captured).catch(
            () => {
              throw new AuthenticationOperationError('COMMIT_OUTCOME_UNKNOWN');
            },
          );
          if (reconciled.status === 'COMMITTED') return reconciled.response;
          throw new AuthenticationOperationError('NOT_COMMITTED');
        }
        throw this.safeFailure(error);
      }
    }
    throw new AuthenticationOperationError('RETRY_EXHAUSTED');
  }

  /** NOT_COMMITTED is authoritative only after the common operation lock and fresh RC read. */
  reconcile(
    id: string,
    request: AuthenticationOperationRequest,
  ): Promise<AuthenticationOperationReconciliation> {
    return this.reconcileCaptured(
      id,
      captureAuthenticationOperation(id, request),
    );
  }

  private async reconcileCaptured(
    id: string,
    captured: CapturedOperation,
  ): Promise<AuthenticationOperationReconciliation> {
    try {
      return await this.transaction(async (tx) => {
        const response = await this.resolveLocked(tx, id, captured);
        return response
          ? { status: 'COMMITTED' as const, response }
          : { status: 'NOT_COMMITTED' as const };
      });
    } catch (error) {
      throw this.safeFailure(error);
    }
  }

  private transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${this.bounds.timeoutSeconds}s`}, true)`;
        return operation(tx);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: this.bounds.timeoutSeconds * 1000,
        maxWait: this.bounds.maxWaitSeconds * 1000,
      },
    );
  }

  private async resolveLocked(
    tx: Prisma.TransactionClient,
    id: string,
    captured: CapturedOperation,
  ): Promise<AuthenticationOperationResponse | null> {
    await this.repository.lock(tx, id);
    // Check after both operation and row waits, using the primary DB clock.
    const row = await this.repository.read(tx, id);
    const now = await this.repository.nowMicros(tx);
    assertAuthenticationOperationActive(id, now);
    return row ? this.response(row, captured, now, true) : null;
  }

  private receipt(
    id: string,
    captured: CapturedOperation,
    raw:
      AuthenticationSignInRequestResult | AuthenticationResendAdmissionResult,
    now: bigint,
  ): Prisma.AuthenticationOperationUncheckedCreateInput {
    const window = authenticationOperationWindow(id);
    const data: Prisma.AuthenticationOperationUncheckedCreateInput = {
      id,
      kind: captured.request.kind,
      requestHash: Uint8Array.from(captured.requestHash),
      issuedAt: new Date(Number(window.issuedAtMicros / 1000n)),
      expiresAt: new Date(Number(window.expiresAtMicros / 1000n)),
      retentionExpiresAt: new Date(
        Number(window.retentionExpiresAtMicros / 1000n),
      ),
      outcome: 'DENIED',
      challengeId: null,
      challengeExpiresAt: null,
      deliveryId: null,
      deliveryOrigin: null,
      admissionNowMicros: null,
      denial: null,
      retryNotBeforeMicros: null,
      deniedPolicyIds: [],
      evaluatedAtMicros: now,
    };
    if (raw.outcome === 'CREATED')
      return {
        ...data,
        outcome: 'CREATED',
        challengeId: raw.delivery.challengeId,
        challengeExpiresAt: 'challenge' in raw ? raw.challenge.expiresAt : null,
        deliveryId: raw.delivery.id,
        deliveryOrigin: raw.delivery.origin,
        admissionNowMicros: raw.operationNowMicros,
      };
    if (raw.outcome === 'REUSED')
      return {
        ...data,
        outcome: 'REUSED',
        challengeId: raw.challenge.id,
        challengeExpiresAt: raw.challenge.expiresAt,
      };
    if (raw.outcome === 'EXISTING')
      return {
        ...data,
        outcome: 'EXISTING',
        challengeId: raw.delivery.challengeId,
        deliveryId: raw.delivery.id,
        deliveryOrigin: raw.delivery.origin,
      };
    return {
      ...data,
      denial: raw.outcome,
      ...(raw.outcome === 'RATE_LIMITED' || raw.outcome === 'GLOBAL_RATE_DENIED'
        ? {
            evaluatedAtMicros: raw.operationNowMicros,
            retryNotBeforeMicros: raw.retryNotBeforeMicros.toString(),
            deniedPolicyIds: [...raw.deniedPolicyIds],
          }
        : {}),
    };
  }

  private response(
    row: AuthenticationOperation,
    captured: CapturedOperation,
    now: bigint,
    replayed: boolean,
  ): AuthenticationOperationResponse {
    if (row.requestHash.length !== 32)
      throw new AuthenticationOperationError('INVALID_STATE');
    if (
      row.kind !== captured.request.kind ||
      !timingSafeEqual(row.requestHash, captured.requestHash)
    )
      throw new AuthenticationOperationError('OPERATION_CONFLICT');
    const window = authenticationOperationWindow(row.id);
    if (
      BigInt(row.issuedAt.getTime()) * 1000n !== window.issuedAtMicros ||
      BigInt(row.expiresAt.getTime()) * 1000n !== window.expiresAtMicros ||
      BigInt(row.retentionExpiresAt.getTime()) * 1000n !==
        window.retentionExpiresAtMicros ||
      row.evaluatedAtMicros < window.issuedAtMicros ||
      row.evaluatedAtMicros >= window.expiresAtMicros
    )
      throw new AuthenticationOperationError('INVALID_STATE');
    const base = { operationId: row.id, replayed };
    if (
      row.retryNotBeforeMicros !== null &&
      (!row.retryNotBeforeMicros.isFinite() ||
        !row.retryNotBeforeMicros.isInteger())
    ) {
      throw new AuthenticationOperationError('INVALID_STATE');
    }
    const retryBoundary =
      row.retryNotBeforeMicros === null
        ? null
        : BigInt(row.retryNotBeforeMicros.toFixed(0));
    if (row.outcome === 'DENIED') {
      if (
        !row.denial ||
        row.challengeId ||
        row.challengeExpiresAt ||
        row.deliveryId ||
        row.deliveryOrigin ||
        row.admissionNowMicros !== null
      )
        throw new AuthenticationOperationError('INVALID_STATE');
      const knownPolicies = [
        globalAdmission.policyId,
        policies.challengeDeliveryCooldown.id,
        policies.identityDeliveryCooldown.id,
        policies.deliveryIdentity.id,
        policies.deliveryIp.id,
      ] as readonly string[];
      if (
        row.denial === 'RATE_LIMITED' ||
        row.denial === 'GLOBAL_RATE_DENIED'
      ) {
        if (
          row.deniedPolicyIds.includes(globalAdmission.policyId) !==
            (row.denial === 'GLOBAL_RATE_DENIED') ||
          retryBoundary === null ||
          retryBoundary <= row.evaluatedAtMicros ||
          !row.deniedPolicyIds.length ||
          row.deniedPolicyIds.some(
            (policy) => !knownPolicies.includes(policy),
          ) ||
          new Set(row.deniedPolicyIds).size !== row.deniedPolicyIds.length
        )
          throw new AuthenticationOperationError('INVALID_STATE');
      } else if (
        row.retryNotBeforeMicros !== null ||
        row.deniedPolicyIds.length
      )
        throw new AuthenticationOperationError('INVALID_STATE');
      const remaining =
        retryBoundary === null
          ? null
          : retryBoundary > now
            ? (retryBoundary - now + 999_999n) / 1_000_000n
            : 0n;
      return {
        ...base,
        result: {
          outcome: 'DENIED',
          denial: row.denial,
          evaluatedAtMicros: row.evaluatedAtMicros,
          retryNotBeforeMicros: retryBoundary,
          remainingWaitSeconds: remaining,
          deniedPolicyIds: [...row.deniedPolicyIds],
        },
      };
    }
    if (
      row.denial !== null ||
      row.retryNotBeforeMicros !== null ||
      row.deniedPolicyIds.length ||
      !row.challengeId
    )
      throw new AuthenticationOperationError('INVALID_STATE');
    assertCanonicalUuid(row.challengeId);
    if (
      row.outcome === 'REUSED' &&
      row.kind === 'SIGN_IN_REQUEST' &&
      row.challengeExpiresAt &&
      !row.deliveryId &&
      !row.deliveryOrigin &&
      row.admissionNowMicros === null
    ) {
      return {
        ...base,
        result: {
          outcome: 'REUSED',
          challengeId: row.challengeId,
          challengeExpiresAt: row.challengeExpiresAt,
        },
      };
    }
    if (!row.deliveryId || !row.deliveryOrigin)
      throw new AuthenticationOperationError('INVALID_STATE');
    assertCanonicalUuid(row.deliveryId);
    if (
      row.outcome === 'EXISTING' &&
      row.kind === 'RESEND' &&
      !row.challengeExpiresAt &&
      row.admissionNowMicros === null
    )
      return {
        ...base,
        result: {
          outcome: 'EXISTING',
          challengeId: row.challengeId,
          deliveryId: row.deliveryId,
          deliveryOrigin: row.deliveryOrigin,
        },
      };
    if (
      row.outcome === 'CREATED' &&
      row.admissionNowMicros !== null &&
      row.admissionNowMicros > 0n &&
      row.admissionNowMicros <= row.evaluatedAtMicros &&
      ((row.kind === 'SIGN_IN_REQUEST' &&
        row.challengeExpiresAt &&
        row.deliveryOrigin === 'INITIAL') ||
        (row.kind === 'RESEND' &&
          !row.challengeExpiresAt &&
          row.deliveryOrigin === 'RESEND'))
    ) {
      return {
        ...base,
        result: {
          outcome: 'CREATED',
          challengeId: row.challengeId,
          challengeExpiresAt: row.challengeExpiresAt,
          deliveryId: row.deliveryId,
          deliveryOrigin: row.deliveryOrigin,
          admissionNowMicros: row.admissionNowMicros,
        },
      };
    }
    throw new AuthenticationOperationError('INVALID_STATE');
  }

  private safeFailure(error: unknown): AuthenticationOperationError {
    return error instanceof AuthenticationOperationError
      ? error
      : new AuthenticationOperationError('STATE_UNAVAILABLE');
  }
}
