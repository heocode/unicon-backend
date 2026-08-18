import type { Prisma } from '../../generated/prisma/client';
import { lockUserForUpdate } from './lock-user-for-update.util';

describe('lockUserForUpdate', () => {
  it('returns the lifecycle fields from the locked user row', async () => {
    const user = {
      status: 'ACTIVE' as const,
      passwordHash: 'password-hash',
      deletionScheduledAt: null,
    };
    const transaction = { $queryRaw: jest.fn().mockResolvedValue([user]) };

    await expect(
      lockUserForUpdate(
        transaction as unknown as Prisma.TransactionClient,
        'user-id',
      ),
    ).resolves.toEqual(user);
  });

  it('returns null when the user does not exist', async () => {
    const transaction = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(
      lockUserForUpdate(
        transaction as unknown as Prisma.TransactionClient,
        'missing-user-id',
      ),
    ).resolves.toBeNull();
  });
});
