import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { GcraAdmissionRepository } from '../../../rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../../../rate-limit/services/rate-limit-bucket-key.service';
import {
  prepareGcraAdmissions,
  assessGcraAdmissions,
} from '../../../rate-limit/utils/gcra-admission-plan.util';
import { chargeGcra } from '../../../rate-limit/utils/gcra-state.util';
import {
  reserveRateLimitTransaction,
  withRateLimitSavepoint,
} from '../../../rate-limit/utils/rate-limit-transaction.util';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../constants/authentication-rate-limit-policies.constants';
import {
  AuthenticationVerificationProofOutcome as ProofOutcome,
  type AuthenticationVerificationRateLimitInput,
  type AuthenticationVerificationProofCheck,
  type AuthenticationVerificationRateLimitResult,
} from '../types/authentication-verification-rate-limit.type';
import { AuthenticationRateLimitConfigService } from './authentication-rate-limit-config.service';

@Injectable()
export class AuthenticationVerificationRateLimitService {
  constructor(
    private readonly config: AuthenticationRateLimitConfigService,
    private readonly derivation: RateLimitBucketKeyService,
    private readonly repository: GcraAdmissionRepository,
  ) {}

  /** Caller locks/resolves challenge and validates purpose/binding/canonical input
   * before entry. No independent transaction, commit, retry or external I/O here. */
  async evaluateInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationVerificationRateLimitInput,
    checkProof: AuthenticationVerificationProofCheck,
  ): Promise<AuthenticationVerificationRateLimitResult> {
    reserveRateLimitTransaction(transaction);
    if (
      typeof input?.expiresAtMicros !== 'bigint' ||
      typeof checkProof !== 'function'
    ) {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
    const expiresAtMicros = input.expiresAtMicros;
    const prepared = prepareGcraAdmissions(
      [
        {
          policy: policies.verificationIdentityShortTerm,
          characteristic: input.normalizedIdentity,
          settings: this.config.verificationIdentityShortTerm,
        },
        {
          policy: policies.verificationIpShortTerm,
          characteristic: input.ipAddress,
          settings: this.config.verificationIpShortTerm,
        },
        {
          policy: policies.verificationIdentityLongTerm,
          characteristic: input.normalizedIdentity,
          settings: this.config.verificationIdentityLongTerm,
        },
        {
          policy: policies.verificationIpLongTerm,
          characteristic: input.ipAddress,
          settings: this.config.verificationIpLongTerm,
        },
      ],
      this.derivation,
    );
    return withRateLimitSavepoint(transaction, this.repository, async () => {
      const keys = [...new Set(prepared.flatMap((item) => item.keys))];
      await this.repository.lockAliases(transaction, keys);
      const rows = await this.repository.readAliases(transaction, keys);
      const now = await this.repository.operationNowMicros(transaction);
      if (expiresAtMicros <= now)
        return Object.freeze({
          outcome: 'EXPIRED' as const,
          operationNowMicros: now,
        });
      const decisions = assessGcraAdmissions(prepared, rows, now);
      const denied = decisions.filter(({ evaluation }) => !evaluation.allowed);
      if (denied.length) {
        return Object.freeze({
          outcome: 'RATE_LIMITED' as const,
          operationNowMicros: now,
          retryAfterSeconds: denied.reduce(
            (latest, { evaluation }) =>
              evaluation.retryAfterSeconds > latest
                ? evaluation.retryAfterSeconds
                : latest,
            0n,
          ),
          retryNotBeforeMicros: denied.reduce((latest, { evaluation }) => {
            const { numerator, denominator } = evaluation.eligibleAt;
            const boundary = (numerator + denominator - 1n) / denominator;
            return boundary > latest ? boundary : latest;
          }, now),
          deniedPolicyIds: Object.freeze(
            denied.map(({ item }) => item.policyId),
          ),
        });
      }

      // Keep the locks and the same DB timestamp through comparison and any charge.
      const outcome = await checkProof(now);
      if (
        outcome !== ProofOutcome.MATCH &&
        outcome !== ProofOutcome.CANONICAL_MISMATCH &&
        outcome !== ProofOutcome.EXCLUDED
      ) {
        throw new GcraAdmissionInfrastructureError('INVALID_STATE');
      }
      if (outcome === ProofOutcome.CANONICAL_MISMATCH) {
        const charges = decisions.map(({ item, state }) => ({
          item,
          state: chargeGcra(state, item.settings, now),
        }));
        for (const { item, state } of charges)
          await this.repository.writeAliases(
            transaction,
            item.keys,
            item.policyId,
            state,
          );
      }
      return Object.freeze({ outcome, operationNowMicros: now });
    });
  }
}
