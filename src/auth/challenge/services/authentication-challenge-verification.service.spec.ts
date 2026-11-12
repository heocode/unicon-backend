import type { Prisma } from '../../../generated/prisma/client';
import { GcraAdmissionInfrastructureError } from '../../../rate-limit/errors/gcra-admission-infrastructure.error';
import type { AuthenticationVerificationProofCheck } from '../../rate-limit/types/authentication-verification-rate-limit.type';
import type { AuthenticationVerificationRateLimitService } from '../../rate-limit/services/authentication-verification-rate-limit.service';
import type { AuthenticationChallengeProofService } from './authentication-challenge-proof.service';
import type { AuthenticationChallengeRepository } from '../repositories/authentication-challenge.repository';
import type { LockedAuthenticationChallenge } from '../repositories/authentication-challenge.repository';
import { AuthenticationChallengeVerificationService } from './authentication-challenge-verification.service';

const now = new Date('2026-11-11T12:00:01.001Z');
const challenge: LockedAuthenticationChallenge = {
  id: 'challenge',
  normalizedIdentity: 'student@example.edu',
  purpose: 'SIGN_IN',
  userId: null,
  boundSessionId: null,
  otpHash: Buffer.alloc(32, 1),
  linkTokenHash: Buffer.alloc(32, 2),
  hashProtocolVersion: 1,
  hashKeyVersion: 1,
  expiresAt: new Date(now.getTime() + 600_000),
  failedAttemptCount: 5,
  consumedAt: null,
  lockedAt: null,
};
const input = {
  challengeId: challenge.id,
  expectedPurpose: 'SIGN_IN' as const,
  expectedBoundSessionId: null,
  ipAddress: '192.0.2.1',
  proof: '004201',
};
function setup() {
  const repository = {
    lockByIdForUpdate: jest.fn().mockResolvedValue(challenge),
    getOperationTimestamp: jest
      .fn()
      .mockResolvedValue(new Date(now.getTime() - 1000)),
    recordProofFailure: jest
      .fn()
      .mockResolvedValue({ failedAttemptCount: 6, lockedAt: null }),
    clearExpiredEnvelope: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
  };
  const proof = {
    verifyOtp: jest.fn().mockReturnValue(true),
    verifyMagicLinkToken: jest.fn().mockReturnValue(true),
  };
  const limiter = {
    evaluateInTransaction: jest
      .fn()
      .mockImplementation(
        async (
          _tx: unknown,
          _input: unknown,
          check: AuthenticationVerificationProofCheck,
        ) => ({
          outcome: await check(BigInt(now.getTime()) * 1000n + 999n),
          operationNowMicros: BigInt(now.getTime()) * 1000n + 999n,
        }),
      ),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ isolation: 'read committed' }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const transaction = tx as unknown as Prisma.TransactionClient;
  return {
    repository,
    proof,
    limiter,
    tx,
    transaction,
    service: new AuthenticationChallengeVerificationService(
      repository as unknown as AuthenticationChallengeRepository,
      proof as unknown as AuthenticationChallengeProofService,
      limiter as unknown as AuthenticationVerificationRateLimitService,
    ),
  };
}

describe('AuthenticationChallengeVerificationService (unit orchestration)', () => {
  it.each(['OTP', 'LINK'])(
    'uses authoritative identity and post-bucket-wait time for %s consumption',
    async (method) => {
      const { service, repository, limiter, transaction } = setup();
      const result = await (method === 'OTP'
        ? service.verifyAndConsumeOtpInTransaction(transaction, input)
        : service.verifyAndConsumeMagicLinkInTransaction(transaction, {
            ...input,
            proof: Buffer.alloc(32, 3).toString('base64url'),
          }));
      expect(result).toMatchObject({
        status: 'VERIFIED',
        challenge: {
          authenticatedAt: now,
          consumedAt: now,
          authenticationMethod:
            method === 'OTP' ? 'EMAIL_OTP' : 'EMAIL_MAGIC_LINK',
        },
      });
      expect(limiter.evaluateInTransaction).toHaveBeenCalledWith(
        transaction,
        {
          normalizedIdentity: challenge.normalizedIdentity,
          ipAddress: input.ipAddress,
          expiresAtMicros: BigInt(challenge.expiresAt.getTime()) * 1000n,
        },
        expect.any(Function),
      );
      expect(repository.consume).toHaveBeenCalledWith(
        transaction,
        challenge.id,
        now,
      );
      expect(repository.recordProofFailure).not.toHaveBeenCalled();
    },
  );
  it.each(['OTP', 'LINK'])(
    'records canonical %s mismatch as a normal chargeable result without a permanent lock',
    async (method) => {
      const { service, repository, proof, transaction } = setup();
      proof.verifyOtp.mockReturnValue(false);
      proof.verifyMagicLinkToken.mockReturnValue(false);
      const result = await (method === 'OTP'
        ? service.verifyAndConsumeOtpInTransaction(transaction, input)
        : service.verifyAndConsumeMagicLinkInTransaction(transaction, {
            ...input,
            proof: Buffer.alloc(32, 3).toString('base64url'),
          }));
      expect(result).toEqual({
        status: 'INVALID_PROOF',
        kind: 'MISMATCH',
        attemptConsumed: true,
        failedAttemptCount: 6,
        locked: false,
        lockedAt: null,
      });
      expect(repository.recordProofFailure).toHaveBeenCalledWith(
        transaction,
        challenge.id,
        now,
      );
      expect(repository.consume).not.toHaveBeenCalled();
    },
  );
  it.each(['4201', ' 004201', '004201 '])(
    'excludes malformed OTP %j before limiter/comparison',
    async (candidate) => {
      const { service, limiter, proof, repository, transaction } = setup();
      expect(
        await service.verifyAndConsumeOtpInTransaction(transaction, {
          ...input,
          proof: candidate,
        }),
      ).toMatchObject({
        status: 'INVALID_PROOF',
        kind: 'MALFORMED',
        attemptConsumed: false,
      });
      expect(limiter.evaluateInTransaction).not.toHaveBeenCalled();
      expect(proof.verifyOtp).not.toHaveBeenCalled();
      expect(repository.recordProofFailure).not.toHaveBeenCalled();
    },
  );
  it('excludes malformed magic links', async () => {
    const { service, limiter, proof, transaction } = setup();
    expect(
      await service.verifyAndConsumeMagicLinkInTransaction(transaction, {
        ...input,
        proof: Buffer.alloc(32).toString('base64url') + '=',
      }),
    ).toMatchObject({ status: 'INVALID_PROOF', kind: 'MALFORMED' });
    expect(limiter.evaluateInTransaction).not.toHaveBeenCalled();
    expect(proof.verifyMagicLinkToken).not.toHaveBeenCalled();
  });
  it.each([
    [null, 'NOT_FOUND'],
    [{ ...challenge, purpose: 'STEP_UP' }, 'PURPOSE_MISMATCH'],
    [{ ...challenge, boundSessionId: 'other' }, 'BINDING_MISMATCH'],
    [{ ...challenge, consumedAt: now }, 'CONSUMED'],
    [{ ...challenge, lockedAt: now }, 'LOCKED'],
  ])(
    'excludes unavailable challenge without limiter or proof comparison (%s)',
    async (row, reason) => {
      const { service, repository, limiter, proof, transaction } = setup();
      repository.lockByIdForUpdate.mockResolvedValue(row);
      expect(
        await service.verifyAndConsumeOtpInTransaction(transaction, input),
      ).toEqual({ status: 'UNAVAILABLE', internalReason: reason });
      expect(limiter.evaluateInTransaction).not.toHaveBeenCalled();
      expect(proof.verifyOtp).not.toHaveBeenCalled();
      expect(repository.consume).not.toHaveBeenCalled();
    },
  );
  it('clears expired envelope before admission', async () => {
    const { service, repository, limiter, transaction } = setup();
    repository.lockByIdForUpdate.mockResolvedValue({
      ...challenge,
      expiresAt: new Date(now.getTime() - 1000),
    });
    expect(
      await service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).toEqual({ status: 'UNAVAILABLE', internalReason: 'EXPIRED' });
    expect(repository.clearExpiredEnvelope).toHaveBeenCalled();
    expect(limiter.evaluateInTransaction).not.toHaveBeenCalled();
  });
  it('clears envelope when challenge expires during bucket waits', async () => {
    const { service, repository, limiter, proof, transaction } = setup();
    limiter.evaluateInTransaction.mockResolvedValue({
      outcome: 'EXPIRED',
      operationNowMicros: BigInt(challenge.expiresAt.getTime()) * 1000n,
    });
    expect(
      await service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).toEqual({ status: 'UNAVAILABLE', internalReason: 'EXPIRED' });
    expect(repository.clearExpiredEnvelope).toHaveBeenCalledWith(
      transaction,
      challenge.id,
      challenge.expiresAt,
    );
    expect(proof.verifyOtp).not.toHaveBeenCalled();
  });
  it('returns authoritative denial without comparing proof or changing diagnostics', async () => {
    const { service, repository, limiter, proof, transaction } = setup();
    const denial = {
      outcome: 'RATE_LIMITED',
      retryAfterSeconds: 10n,
      retryNotBeforeMicros: 123n,
      deniedPolicyIds: ['policy'],
    };
    limiter.evaluateInTransaction.mockResolvedValue(denial);
    expect(
      await service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).toEqual({
      status: 'RATE_LIMITED',
      retryAfterSeconds: 10n,
      retryNotBeforeMicros: 123n,
      deniedPolicyIds: ['policy'],
    });
    expect(proof.verifyOtp).not.toHaveBeenCalled();
    expect(repository.recordProofFailure).not.toHaveBeenCalled();
    expect(repository.consume).not.toHaveBeenCalled();
  });
  it('fails closed on infrastructure failure and rolls back its savepoint even if caught by owner', async () => {
    const { service, limiter, proof, tx, transaction } = setup();
    limiter.evaluateInTransaction.mockRejectedValue(
      new GcraAdmissionInfrastructureError('STATE_UNAVAILABLE'),
    );
    await expect(
      service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'STATE_UNAVAILABLE' });
    expect(proof.verifyOtp).not.toHaveBeenCalled();
    expect(
      tx.$executeRaw.mock.calls.map((args: [TemplateStringsArray]) =>
        args[0].join(''),
      ),
    ).toContain('ROLLBACK TO SAVEPOINT unicon_challenge_verification');
  });
  it('does not expose raw cryptographic errors', async () => {
    const { service, proof, transaction } = setup();
    proof.verifyOtp.mockImplementation(() => {
      throw new Error('Sensitive key detail');
    });
    await expect(
      service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).rejects.toBeInstanceOf(GcraAdmissionInfrastructureError);
  });
  it('rejects root client, reused transaction and unsupported isolation before proof', async () => {
    const { service, tx, transaction, repository, proof } = setup();
    await expect(
      service.verifyAndConsumeOtpInTransaction(
        {
          ...tx,
          $connect: () => undefined,
        } as unknown as Prisma.TransactionClient,
        input,
      ),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    tx.$queryRaw.mockResolvedValue([{ isolation: 'repeatable read' }]);
    await expect(
      service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    await expect(
      service.verifyAndConsumeOtpInTransaction(transaction, input),
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSACTION' });
    expect(repository.lockByIdForUpdate).not.toHaveBeenCalled();
    expect(proof.verifyOtp).not.toHaveBeenCalled();
  });
});
