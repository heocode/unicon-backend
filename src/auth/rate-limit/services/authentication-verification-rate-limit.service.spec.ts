import { ConfigService } from '@nestjs/config';

import { Prisma, type GcraRateLimit } from '../../../generated/prisma/client';
import { RateLimitBucketKeyService } from '../../../rate-limit/services/rate-limit-bucket-key.service';
import { createGcraState } from '../../../rate-limit/utils/gcra-state.util';
import { toGcraPersistenceData } from '../../../rate-limit/utils/gcra-state-persistence.util';
import { AUTHENTICATION_RATE_LIMIT_POLICIES as policies } from '../constants/authentication-rate-limit-policies.constants';
import {
  AuthenticationVerificationProofOutcome as Outcome,
  type AuthenticationVerificationProofOutcome,
} from '../types/authentication-verification-rate-limit.type';
import { AuthenticationVerificationRateLimitService } from './authentication-verification-rate-limit.service';
import { AuthenticationRateLimitConfigService } from './authentication-rate-limit-config.service';

const configs = {
  verificationIdentityShortTerm: { burst: 6, rate: 6, periodSeconds: 60 },
  verificationIpShortTerm: { burst: 72, rate: 72, periodSeconds: 60 },
  verificationIdentityLongTerm: { burst: 8, rate: 12, periodSeconds: 3600 },
  verificationIpLongTerm: { burst: 360, rate: 360, periodSeconds: 3600 },
};
const input = {
  normalizedIdentity: 'student@example.edu',
  ipAddress: '192.0.2.1',
  expiresAtMicros: 600_000_000n,
};

function setup(now = 123_456n) {
  const derivation = new RateLimitBucketKeyService(
    new ConfigService({
      RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION: 2,
      RATE_LIMIT_HMAC_KEYS: new Map([
        [1, Buffer.alloc(32, 4)],
        [2, Buffer.alloc(32, 5)],
      ]),
    }),
  );
  const repository = {
    isolationLevel: jest.fn().mockResolvedValue('read committed'),
    lockAliases: jest
      .fn<Promise<void>, [Prisma.TransactionClient, readonly string[]]>()
      .mockResolvedValue(undefined),
    readAliases: jest
      .fn<
        Promise<GcraRateLimit[]>,
        [Prisma.TransactionClient, readonly string[]]
      >()
      .mockResolvedValue([]),
    operationNowMicros: jest.fn().mockResolvedValue(now),
    writeAliases: jest.fn().mockResolvedValue(undefined),
  };
  const tx = {
    $executeRaw: jest
      .fn<Promise<number>, [TemplateStringsArray]>()
      .mockResolvedValue(0),
  };
  const transaction = tx as unknown as Prisma.TransactionClient;
  const check = jest
    .fn<Promise<AuthenticationVerificationProofOutcome>, [bigint]>()
    .mockResolvedValue(Outcome.CANONICAL_MISMATCH);
  const service = new AuthenticationVerificationRateLimitService(
    configs as AuthenticationRateLimitConfigService,
    derivation,
    repository,
  );
  return { service, repository, transaction, tx, check, derivation, now };
}

function row(
  derivation: RateLimitBucketKeyService,
  name: keyof typeof configs,
  eligibleAt: bigint,
): GcraRateLimit {
  const policy = policies[name],
    settings = configs[name];
  const characteristic =
    policy.characteristicKind === 'IP'
      ? input.ipAddress
      : input.normalizedIdentity;
  const data = toGcraPersistenceData(
    createGcraState(
      {
        numerator:
          eligibleAt * BigInt(settings.rate) +
          BigInt(settings.burst - 1) *
            BigInt(settings.periodSeconds) *
            1_000_000n,
        denominator: BigInt(settings.rate),
      },
      settings,
    ),
  );
  return {
    key: derivation.deriveKeys(policy, characteristic).buckets[0].key,
    policyId: policy.id,
    ...data,
    tatNumerator: new Prisma.Decimal(data.tatNumerator),
    tatDenominator: new Prisma.Decimal(data.tatDenominator),
    idleAfterMicros: new Prisma.Decimal(data.idleAfterMicros),
    updatedAt: new Date(0),
  };
}

describe('AuthenticationVerificationRateLimitService (unit)', () => {
  it('locks all four policies and all aliases once, then checks proof before charging at the one DB timestamp', async () => {
    const { service, repository, transaction, check, now } = setup();
    expect(
      await service.evaluateInTransaction(transaction, input, check),
    ).toEqual({ outcome: Outcome.CANONICAL_MISMATCH, operationNowMicros: now });
    expect(repository.lockAliases).toHaveBeenCalledTimes(1);
    expect(repository.lockAliases.mock.calls[0][1]).toHaveLength(8);
    expect(repository.operationNowMicros).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(now);
    expect(repository.readAliases.mock.invocationCallOrder[0]).toBeLessThan(
      repository.operationNowMicros.mock.invocationCallOrder[0],
    );
    expect(
      repository.operationNowMicros.mock.invocationCallOrder[0],
    ).toBeLessThan(check.mock.invocationCallOrder[0]);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(
      repository.writeAliases.mock.invocationCallOrder[0],
    );
    expect(repository.writeAliases).toHaveBeenCalledTimes(4);
  });

  it.each([Outcome.MATCH, Outcome.EXCLUDED])(
    'does not charge or repair missing aliases on %s',
    async (outcome) => {
      const { service, repository, transaction, check, now } = setup();
      check.mockResolvedValue(outcome);
      expect(
        await service.evaluateInTransaction(transaction, input, check),
      ).toEqual({ outcome, operationNowMicros: now });
      expect(repository.writeAliases).not.toHaveBeenCalled();
    },
  );

  it('aggregates denial and rounds only the reported seconds without invoking proof comparison', async () => {
    const { service, repository, transaction, check, derivation, now } =
      setup();
    repository.readAliases.mockResolvedValue([
      row(derivation, 'verificationIdentityShortTerm', now + 999_999n),
      row(derivation, 'verificationIpLongTerm', now + 60_000_001n),
    ]);
    expect(
      await service.evaluateInTransaction(transaction, input, check),
    ).toEqual({
      outcome: 'RATE_LIMITED',
      operationNowMicros: now,
      retryAfterSeconds: 61n,
      retryNotBeforeMicros: now + 60_000_001n,
      deniedPolicyIds: [
        policies.verificationIdentityShortTerm.id,
        policies.verificationIpLongTerm.id,
      ],
    });
    expect(check).not.toHaveBeenCalled();
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it('does not mask invalid later policy state behind an earlier denial', async () => {
    const { service, repository, transaction, check, derivation, now } =
      setup();
    repository.readAliases.mockResolvedValue([
      row(derivation, 'verificationIdentityLongTerm', now + 1n),
      {
        ...row(derivation, 'verificationIpShortTerm', now + 1n),
        policyId: 'WRONG_POLICY',
      },
    ]);
    await expect(
      service.evaluateInTransaction(transaction, input, check),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(check).not.toHaveBeenCalled();
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it.each([-1n, 0n, 1n])(
    'checks expiry exactly at the post-lock boundary (%s microseconds)',
    async (offset) => {
      const { service, repository, transaction, check, now } = setup();
      check.mockResolvedValue(Outcome.MATCH);
      expect(
        await service.evaluateInTransaction(
          transaction,
          { ...input, expiresAtMicros: now + offset },
          check,
        ),
      ).toEqual({
        outcome: offset <= 0n ? 'EXPIRED' : Outcome.MATCH,
        operationNowMicros: now,
      });
      expect(check).toHaveBeenCalledTimes(offset <= 0n ? 0 : 1);
      expect(repository.writeAliases).not.toHaveBeenCalled();
    },
  );

  it('rolls back all post-savepoint work if a later policy charge fails', async () => {
    const { service, repository, transaction, check, tx } = setup();
    repository.writeAliases
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Sensitive SQL details.'));
    await expect(
      service.evaluateInTransaction(transaction, input, check),
    ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(tx.$executeRaw.mock.calls.map(([sql]) => sql.join(''))).toEqual([
      'SAVEPOINT unicon_gcra_admission',
      'ROLLBACK TO SAVEPOINT unicon_gcra_admission',
      'RELEASE SAVEPOINT unicon_gcra_admission',
    ]);
  });

  it('does not fabricate a mismatch or charge for a proof infrastructure error', async () => {
    const { service, repository, transaction, check } = setup();
    check.mockRejectedValue(new Error('Unavailable crypto key.'));
    await expect(
      service.evaluateInTransaction(transaction, input, check),
    ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it('fails closed on an unclassified callback outcome', async () => {
    const { service, repository, transaction, check } = setup();
    check.mockResolvedValue(
      'UNCLASSIFIED' as AuthenticationVerificationProofOutcome,
    );
    await expect(
      service.evaluateInTransaction(transaction, input, check),
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    expect(repository.writeAliases).not.toHaveBeenCalled();
  });

  it.each([' Student@example.edu', 'Student@example.edu'])(
    'rejects invalid authoritative identity before locks (%s)',
    async (normalizedIdentity) => {
      const { service, repository, transaction, check } = setup();
      await expect(
        service.evaluateInTransaction(
          transaction,
          { ...input, normalizedIdentity },
          check,
        ),
      ).rejects.toMatchObject({ reason: 'INVALID_INPUT' });
      expect(repository.lockAliases).not.toHaveBeenCalled();
    },
  );

  it('rejects a second rate operation in the same transaction', async () => {
    const { service, repository, transaction, check } = setup();
    check.mockResolvedValue(Outcome.MATCH);
    await service.evaluateInTransaction(transaction, input, check);
    await expect(
      service.evaluateInTransaction(transaction, input, check),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(repository.lockAliases).toHaveBeenCalledTimes(1);
  });
});
