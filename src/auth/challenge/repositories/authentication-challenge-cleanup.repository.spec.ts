import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuthenticationChallengeCleanupRepository } from './authentication-challenge-cleanup.repository';

describe('AuthenticationChallengeCleanupRepository', () => {
  type SqlQuery = { strings: readonly string[] };

  const operationNow = new Date('2026-09-04T12:00:00.000Z');
  const transaction = { $queryRaw: jest.fn() };
  const prisma = {
    $transaction: jest.fn(
      (operation: (client: Prisma.TransactionClient) => Promise<number>) =>
        operation(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  let repository: AuthenticationChallengeCleanupRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new AuthenticationChallengeCleanupRepository(
      prisma as unknown as PrismaService,
    );
    transaction.$queryRaw
      .mockResolvedValueOnce([{ operationNow }])
      .mockResolvedValueOnce([{ id: 'challenge-id' }]);
  });

  it('locks and clears one expired envelope batch in one transaction', async () => {
    await expect(repository.clearOneExpiredEnvelopeBatch(100)).resolves.toBe(1);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (
      transaction.$queryRaw.mock.calls[1] as [SqlQuery]
    )[0].strings.join(' ');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('UPDATE "AuthenticationChallenge"');
    expect(sql).toContain('"encryptedProof" = NULL');
    expect(sql).toContain('RETURNING "challenge"."id"');
  });

  it('locks and deletes one retained batch in one transaction', async () => {
    await expect(repository.deleteOneRetainedChallengeBatch(100)).resolves.toBe(
      1,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = (
      transaction.$queryRaw.mock.calls[1] as [SqlQuery]
    )[0].strings.join(' ');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('"retentionExpiresAt" <=');
    expect(sql).toContain('DELETE FROM "AuthenticationChallenge"');
    expect(sql).toContain('RETURNING "challenge"."id"');
  });
});
