import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../../generated/prisma/client';

import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import { GcraAdmissionRepository } from '../../../rate-limit/repositories/gcra-admission.repository';
import { RateLimitBucketKeyService } from '../../../rate-limit/services/rate-limit-bucket-key.service';
import {
  prepareGcraAdmissions,
  assessGcraAdmissions,
} from '../../../rate-limit/utils/gcra-admission-plan.util';
import {
  chargeGcra,
  createGcraState,
} from '../../../rate-limit/utils/gcra-state.util';
import {
  reserveRateLimitTransaction,
  withRateLimitSavepoint,
} from '../../../rate-limit/utils/rate-limit-transaction.util';
import { AUTHENTICATION_GLOBAL_DELIVERY_ADMISSION as globalAdmission } from '../constants/authentication-global-delivery-admission.constants';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../constants/authentication-rate-limit-policies.constants';
import { AuthenticationDeliveryCooldownRepository } from '../repositories/authentication-delivery-cooldown.repository';
import type {
  AuthenticationDeliveryCooldownAlias,
  AuthenticationDeliveryRateLimitInput,
  AuthenticationDeliveryRateLimitResult,
  AuthenticationDeliveryAdmissionWindow,
  AuthenticationDeliveryWindowDenial,
} from '../types/authentication-delivery-rate-limit.type';
import { authenticationDeliveryWindowOutcome } from '../utils/authentication-delivery-window.util';
import { AuthenticationRateLimitConfigService } from './authentication-rate-limit-config.service';

@Injectable()
export class AuthenticationDeliveryRateLimitService {
  constructor(
    private readonly config: AuthenticationRateLimitConfigService,
    private readonly derivation: RateLimitBucketKeyService,
    private readonly gcraRepository: GcraAdmissionRepository,
    private readonly cooldownRepository: AuthenticationDeliveryCooldownRepository,
  ) {}

  /** New work only. Caller owns lifecycle/unfinished-work checks and commit. */
  admitInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationDeliveryRateLimitInput,
  ): Promise<AuthenticationDeliveryRateLimitResult>;
  admitInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationDeliveryRateLimitInput,
    window: AuthenticationDeliveryAdmissionWindow,
  ): Promise<
    AuthenticationDeliveryRateLimitResult | AuthenticationDeliveryWindowDenial
  >;
  async admitInTransaction(
    transaction: Prisma.TransactionClient,
    input: AuthenticationDeliveryRateLimitInput,
    window?: AuthenticationDeliveryAdmissionWindow,
  ): Promise<
    AuthenticationDeliveryRateLimitResult | AuthenticationDeliveryWindowDenial
  > {
    reserveRateLimitTransaction(transaction);
    const { gcra, cooldowns } = this.prepare(input);
    const capturedWindow = window ? { ...window } : undefined;
    if (
      capturedWindow &&
      (typeof capturedWindow.expiresAtMicros !== 'bigint' ||
        !Number.isSafeInteger(capturedWindow.minValidityRemainingSeconds) ||
        capturedWindow.minValidityRemainingSeconds <= 0)
    )
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    return withRateLimitSavepoint(
      transaction,
      this.gcraRepository,
      async () => {
        const gcraKeys = gcra.flatMap((item) => item.keys);
        const cooldownKeys = cooldowns.flatMap((item) => item.keys);
        await this.gcraRepository.lockAliases(transaction, [
          ...new Set([...gcraKeys, ...cooldownKeys]),
        ]);
        // Fixed table order. Clock sampling follows every row-lock wait in both tables.
        const gcraRows = await this.gcraRepository.readAliases(
          transaction,
          gcraKeys,
        );
        const cooldownRows = await this.cooldownRepository.readAliases(
          transaction,
          cooldownKeys,
        );
        const now = await this.gcraRepository.operationNowMicros(transaction);
        const windowOutcome = capturedWindow
          ? authenticationDeliveryWindowOutcome(capturedWindow, now)
          : null;
        if (windowOutcome)
          return Object.freeze({
            allowed: false as const,
            operationNowMicros: now,
            windowOutcome,
          });
        const gcraDecisions = assessGcraAdmissions(gcra, gcraRows, now);
        const cooldownDecisions = cooldowns.map((item) => {
          const blockedUntil = this.cooldownBoundary(cooldownRows, item.keys);
          const wait = blockedUntil > now ? blockedUntil - now : 0n;
          return {
            ...item,
            blockedUntil,
            retryAfterSeconds: (wait + 999_999n) / 1_000_000n,
            nextBoundary: now + BigInt(item.intervalSeconds) * 1_000_000n,
          };
        });
        const denied = [
          ...gcraDecisions
            .filter(({ evaluation }) => !evaluation.allowed)
            .map(({ item, evaluation }) => ({
              policyId: item.policyId,
              retryAfterSeconds: evaluation.retryAfterSeconds,
              blockedUntil:
                (evaluation.eligibleAt.numerator +
                  evaluation.eligibleAt.denominator -
                  1n) /
                evaluation.eligibleAt.denominator,
            })),
          ...cooldownDecisions.filter((item) => item.retryAfterSeconds > 0n),
        ].sort((left, right) =>
          left.policyId < right.policyId
            ? -1
            : left.policyId > right.policyId
              ? 1
              : 0,
        );
        if (denied.length > 0) {
          return Object.freeze({
            allowed: false as const,
            operationNowMicros: now,
            retryNotBeforeMicros: denied.reduce(
              (latest, item) =>
                item.blockedUntil > latest ? item.blockedUntil : latest,
              now,
            ),
            retryAfterSeconds: denied.reduce(
              (latest, item) =>
                item.retryAfterSeconds > latest
                  ? item.retryAfterSeconds
                  : latest,
              0n,
            ),
            deniedPolicyIds: Object.freeze(denied.map((item) => item.policyId)),
          });
        }
        const charges = gcraDecisions.map(({ item, state }) => ({
          item,
          state: chargeGcra(state, item.settings, now),
        }));
        for (const { item, state } of charges)
          await this.gcraRepository.writeAliases(
            transaction,
            item.keys,
            item.policyId,
            state,
          );
        for (const item of cooldownDecisions)
          await this.cooldownRepository.writeAliases(
            transaction,
            item.keys,
            item.nextBoundary,
          );
        return Object.freeze({
          allowed: true as const,
          operationNowMicros: now,
        });
      },
    );
  }

  private prepare(input: AuthenticationDeliveryRateLimitInput) {
    try {
      const personal = prepareGcraAdmissions(
        [
          {
            policy: policies.deliveryIdentity,
            characteristic: input.normalizedIdentity,
            settings: this.config.deliveryIdentity,
          },
          {
            policy: policies.deliveryIp,
            characteristic: input.ipAddress,
            settings: this.config.deliveryIp,
          },
        ],
        this.derivation,
      );
      const gcra = [
        ...personal,
        {
          policyId: globalAdmission.policyId,
          keys: [globalAdmission.key],
          settings: createGcraState(
            { numerator: 0n, denominator: 1n },
            this.config.deliveryGlobal,
          ).policy,
        },
      ].sort((left, right) =>
        left.policyId < right.policyId
          ? -1
          : left.policyId > right.policyId
            ? 1
            : 0,
      );
      const cooldowns = [
        {
          policy: policies.challengeDeliveryCooldown,
          value: input.challengeId,
          intervalSeconds: this.config.challengeDeliveryCooldownSeconds,
        },
        {
          policy: policies.identityDeliveryCooldown,
          value: input.normalizedIdentity,
          intervalSeconds: this.config.identityDeliveryCooldownSeconds,
        },
      ].map(({ policy, value, intervalSeconds }) => {
        if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0)
          throw new Error('Invalid cooldown configuration.');
        return {
          policyId: policy.id,
          keys: this.derivation
            .deriveKeys(policy, value)
            .buckets.map((bucket) => bucket.key),
          intervalSeconds,
        };
      });
      return { gcra, cooldowns };
    } catch {
      throw new GcraAdmissionInfrastructureError('INVALID_INPUT');
    }
  }

  private cooldownBoundary(
    rows: readonly AuthenticationDeliveryCooldownAlias[],
    keys: readonly string[],
  ): bigint {
    let latest = 0n;
    for (const row of rows.filter((candidate) =>
      keys.includes(candidate.key),
    )) {
      if (
        row.count !== 1 ||
        row.windowEndAtMicros === null ||
        !/^-?\d+$/.test(row.windowEndAtMicros)
      ) {
        throw new GcraAdmissionInfrastructureError('INVALID_STATE');
      }
      const boundary = BigInt(row.windowEndAtMicros);
      if (boundary > latest) latest = boundary;
    }
    return latest;
  }
}
