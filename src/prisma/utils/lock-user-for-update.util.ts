import { Prisma } from '../../generated/prisma/client';

import type { UserStatus } from '../../generated/prisma/client';

export type LockedUser = {
  status: UserStatus;
  passwordHash: string;
  deletionScheduledAt: Date | null;
};

export async function lockUserForUpdate(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<LockedUser | null> {
  const users = await transaction.$queryRaw<LockedUser[]>(
    Prisma.sql`
      SELECT "status", "passwordHash", "deletionScheduledAt"
      FROM "User"
      WHERE "id" = ${userId}
      FOR UPDATE
    `,
  );

  return users[0] ?? null;
}
