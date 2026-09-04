import type { Prisma } from '../../../generated/prisma/client';

import { AuthenticationChallengeTransitionConflictError } from '../errors/authentication-challenge-transition-conflict.error';
import { AuthenticationChallengeRepository } from './authentication-challenge.repository';

describe('AuthenticationChallengeRepository', () => {
  type SqlQuery = { strings: readonly string[] };

  const challengeId = '123e4567-e89b-42d3-a456-426614174000';
  const operationNow = new Date('2026-09-04T12:00:00.000Z');
  const repository = new AuthenticationChallengeRepository();

  it('returns the row selected under a PostgreSQL update lock', async () => {
    const challenge = { id: challengeId };
    const transaction = { $queryRaw: jest.fn().mockResolvedValue([challenge]) };

    await expect(
      repository.lockByIdForUpdate(
        transaction as unknown as Prisma.TransactionClient,
        challengeId,
      ),
    ).resolves.toBe(challenge);

    const query = (transaction.$queryRaw.mock.calls as [[SqlQuery]])[0][0];
    expect(query.strings.join(' ')).toContain('FOR UPDATE');
  });

  it('gets a non-transaction-start database timestamp', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ operationNow }]),
    };

    await expect(
      repository.getOperationTimestamp(
        transaction as unknown as Prisma.TransactionClient,
      ),
    ).resolves.toBe(operationNow);

    const query = (transaction.$queryRaw.mock.calls as [[SqlQuery]])[0][0];
    expect(query.strings.join(' ')).toContain('clock_timestamp()');
  });

  it('records an OTP failure and terminal lock through one UPDATE RETURNING', async () => {
    const transition = {
      failedAttemptCount: 5,
      maxAttempts: 5,
      lockedAt: operationNow,
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([transition]),
    };

    await expect(
      repository.recordOtpFailure(
        transaction as unknown as Prisma.TransactionClient,
        challengeId,
        operationNow,
      ),
    ).resolves.toBe(transition);

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (
      transaction.$queryRaw.mock.calls as [[SqlQuery]]
    )[0][0].strings.join(' ');
    expect(sql).toContain('UPDATE "AuthenticationChallenge"');
    expect(sql).toContain('"failedAttemptCount" + 1');
    expect(sql).toContain('"encryptedProof" = CASE');
    expect(sql).toContain(
      'RETURNING "failedAttemptCount", "maxAttempts", "lockedAt"',
    );
  });

  it.each(['recordOtpFailure', 'consume', 'clearExpiredEnvelope'] as const)(
    'rejects a lost %s transition',
    async (method) => {
      const transaction = { $queryRaw: jest.fn().mockResolvedValue([]) };

      await expect(
        method === 'recordOtpFailure'
          ? repository.recordOtpFailure(
              transaction as unknown as Prisma.TransactionClient,
              challengeId,
              operationNow,
            )
          : repository[method](
              transaction as unknown as Prisma.TransactionClient,
              challengeId,
              operationNow,
            ),
      ).rejects.toBeInstanceOf(AuthenticationChallengeTransitionConflictError);
    },
  );
});
