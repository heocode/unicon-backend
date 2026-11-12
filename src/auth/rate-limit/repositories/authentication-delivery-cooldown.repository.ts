import { Injectable } from '@nestjs/common';

import { Prisma } from '../../../generated/prisma/client';

import type { AuthenticationDeliveryCooldownAlias } from '../types/authentication-delivery-rate-limit.type';

const MICROS_PER_DAY = 86_400_000_000n;

@Injectable()
export class AuthenticationDeliveryCooldownRepository {
  readAliases(
    transaction: Prisma.TransactionClient,
    keys: readonly string[],
  ): Promise<AuthenticationDeliveryCooldownAlias[]> {
    return transaction.$queryRaw<
      AuthenticationDeliveryCooldownAlias[]
    >(Prisma.sql`
      SELECT "key", "count",
        CASE WHEN isfinite("windowEndAt")
          THEN trunc(EXTRACT(EPOCH FROM "windowEndAt") * 1000000)::text
          ELSE NULL END AS "windowEndAtMicros"
      FROM "AuthenticationRateLimit"
      WHERE "key" IN (${Prisma.join(keys)})
      ORDER BY "key"
      FOR UPDATE
    `);
  }

  async writeAliases(
    transaction: Prisma.TransactionClient,
    keys: readonly string[],
    windowEndAtMicros: bigint,
  ): Promise<void> {
    // Each factor is an exactly representable integer; never convert an epoch
    // timestamp through Date or a floating-point number of seconds.
    const days = (windowEndAtMicros / MICROS_PER_DAY).toString();
    const remainder = (windowEndAtMicros % MICROS_PER_DAY).toString();
    for (const key of [...keys].sort()) {
      await transaction.$executeRaw`
        INSERT INTO "AuthenticationRateLimit" ("key", "count", "windowEndAt", "updatedAt")
        VALUES (${key}, 1,
          TIMESTAMP '1970-01-01' + ${days}::integer * INTERVAL '1 day'
            + ${remainder}::bigint * INTERVAL '1 microsecond',
          clock_timestamp())
        ON CONFLICT ("key") DO UPDATE SET
          "count" = 1, "windowEndAt" = EXCLUDED."windowEndAt", "updatedAt" = EXCLUDED."updatedAt"
      `;
    }
  }
}
