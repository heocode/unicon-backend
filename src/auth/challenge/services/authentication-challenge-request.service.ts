import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { Prisma } from '../../../generated/prisma/client';

import { canonicalizeIp } from '../../../common/utils/canonicalize-ip.util';
import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { isRetryableGcraTransactionError } from '../../../rate-limit/utils/is-retryable-gcra-transaction-error.util';
import { AuthenticationDeliveryAdmissionService } from '../../delivery/services/authentication-delivery-admission.service';
import { AuthenticationChallengeRequestRepository } from '../repositories/authentication-challenge-request.repository';
import type {
  AuthenticationSignInRequestInput,
  AuthenticationSignInRequestResult,
} from '../types/authentication-challenge-request.type';
import { AuthenticationChallengeConfigService } from './authentication-challenge-config.service';
import { AuthenticationChallengeProofFactoryService } from './authentication-challenge-proof-factory.service';

@Injectable()
export class AuthenticationChallengeRequestService {
  private static readonly transactions =
    new WeakSet<Prisma.TransactionClient>();

  constructor(
    private readonly repository: AuthenticationChallengeRequestRepository,
    private readonly config: AuthenticationChallengeConfigService,
    private readonly proofs: AuthenticationChallengeProofFactoryService,
    private readonly deliveries: AuthenticationDeliveryAdmissionService,
  ) {}

  /** Caller owns institution/domain eligibility, bounds, commit and whole-owner retries. */
  async requestSignInInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationSignInRequestInput,
  ): Promise<AuthenticationSignInRequestResult> {
    if (
      ('$connect' in transaction && transaction.$connect !== undefined) ||
      AuthenticationChallengeRequestService.transactions.has(transaction)
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
    }
    AuthenticationChallengeRequestService.transactions.add(transaction);
    const captured = this.capture(input);
    try {
      const [row] = await transaction.$queryRaw<{ isolation: string }[]>`
        SELECT current_setting('transaction_isolation') AS "isolation"
      `;
      if (
        row?.isolation !== 'read committed' &&
        row?.isolation !== 'serializable'
      ) {
        throw new GcraAdmissionInfrastructureError('INVALID_TRANSACTION');
      }
      await transaction.$executeRaw`SAVEPOINT unicon_challenge_request`;
    } catch (error) {
      throw this.failure(error);
    }
    try {
      const result = await this.request(transaction, captured);
      if (result.outcome !== 'CREATED' && result.outcome !== 'REUSED') {
        // A returned business denial must not leave a candidate challenge or subject.
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_challenge_request`;
      }
      await transaction.$executeRaw`RELEASE SAVEPOINT unicon_challenge_request`;
      return result;
    } catch (error) {
      try {
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT unicon_challenge_request`;
        await transaction.$executeRaw`RELEASE SAVEPOINT unicon_challenge_request`;
      } catch {
        throw new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
      }
      throw this.failure(error);
    }
  }

  private async request(
    transaction: Prisma.TransactionClient,
    input: AuthenticationSignInRequestInput,
  ): Promise<AuthenticationSignInRequestResult> {
    const subjectKey = await this.repository.lockSignInSubject(
      transaction,
      randomUUID(),
      input.normalizedIdentity,
    );
    const candidates = await this.repository.lockSignInCandidates(
      transaction,
      input.normalizedIdentity,
    );
    const now = await this.repository.getOperationTimestamp(transaction);
    const live = candidates.filter((candidate) => candidate.expiresAt > now);
    if (live.length > 1)
      throw new GcraAdmissionInfrastructureError('INVALID_STATE');
    if (live.length === 1) {
      const candidate = live[0];
      if (!candidate.hasProof) {
        return { outcome: 'CHALLENGE_UNAVAILABLE' };
      }
      return {
        outcome: 'REUSED',
        challenge: { id: candidate.id, expiresAt: candidate.expiresAt },
      };
    }

    const challengeId = randomUUID();
    const { persistence } = this.proofs.generate({
      challengeId,
      purpose: 'SIGN_IN',
      normalizedIdentity: input.normalizedIdentity,
    });
    const retentionExpiresAt = new Date(
      now.getTime() + this.config.retentionSeconds * 1_000,
    );
    const challenge = await this.repository.createSignInChallenge(transaction, {
      id: challengeId,
      subjectKey,
      normalizedIdentity: input.normalizedIdentity,
      persistence,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.ttlSeconds * 1_000),
      retentionExpiresAt,
    });
    const admission = await this.deliveries.admitInitialInTransaction(
      transaction,
      {
        challengeId,
        ipAddress: input.ipAddress,
        idempotencyKey: input.idempotencyKey,
        templateProtocolVersion: input.templateProtocolVersion,
        retentionExpiresAt,
      },
    );
    if (admission.outcome !== 'CREATED') return admission;
    return { ...admission, challenge };
  }

  private capture(
    input: AuthenticationSignInRequestInput,
  ): AuthenticationSignInRequestInput {
    try {
      const identity = input.normalizedIdentity;
      // Syntax/allowed-domain validation is the caller's precondition. Require
      // the same canonical identity representation used by rate-limit buckets.
      if (
        typeof identity !== 'string' ||
        !identity ||
        identity !== identity.trim() ||
        identity !== identity.toLowerCase() ||
        /\p{Cc}/u.test(identity) ||
        Buffer.from(identity, 'utf8').toString('utf8') !== identity ||
        typeof input.idempotencyKey !== 'string' ||
        !input.idempotencyKey ||
        !Number.isSafeInteger(input.templateProtocolVersion) ||
        input.templateProtocolVersion <= 0
      ) {
        throw new Error('Invalid SIGN_IN request context.');
      }
      return {
        normalizedIdentity: identity,
        ipAddress: canonicalizeIp(input.ipAddress),
        idempotencyKey: input.idempotencyKey,
        templateProtocolVersion: input.templateProtocolVersion,
      };
    } catch {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
  }

  private failure(error: unknown): GcraAdmissionInfrastructureError {
    if (isRetryableGcraTransactionError(error))
      return new GcraAdmissionInfrastructureError('TRANSACTION_ABORTED');
    return error instanceof GcraAdmissionInfrastructureError
      ? error
      : new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE');
  }
}
