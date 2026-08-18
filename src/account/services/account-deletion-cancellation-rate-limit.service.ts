import { createHmac } from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isTransactionConflict } from '../../prisma/utils/is-transaction-conflict.util';

@Injectable()
export class AccountDeletionCancellationRateLimitService {
  private readonly windowSeconds: number;
  private readonly emailLimit: number;
  private readonly ipLimit: number;
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.windowSeconds = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS',
    );
    this.emailLimit = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL',
    );
    this.ipLimit = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP',
    );
    this.secret = configService.getOrThrow<string>(
      'ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET',
    );
  }

  consumeEmail(
    email: string,
  ): Promise<AccountDeletionCancellationRateLimitResult> {
    return this.consume('email', email, this.emailLimit);
  }

  consumeIp(
    ipAddress: string | undefined,
  ): Promise<AccountDeletionCancellationRateLimitResult> {
    return this.consume('ip', ipAddress ?? 'unknown', this.ipLimit);
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result =
      await this.prisma.accountDeletionCancellationRateLimit.deleteMany({
        where: { windowEndAt: { lte: now } },
      });
    return result.count;
  }

  private async consume(
    scope: 'email' | 'ip',
    value: string,
    limit: number,
  ): Promise<AccountDeletionCancellationRateLimitResult> {
    const digest = createHmac('sha256', this.secret)
      .update(value)
      .digest('hex');
    const key = `${scope}:${digest}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const now = new Date();
            const bucket =
              await transaction.accountDeletionCancellationRateLimit.findUnique(
                { where: { key } },
              );

            if (!bucket || bucket.windowEndAt <= now) {
              await transaction.accountDeletionCancellationRateLimit.upsert({
                where: { key },
                create: {
                  key,
                  count: 1,
                  windowEndAt: new Date(
                    now.getTime() + this.windowSeconds * 1000,
                  ),
                },
                update: {
                  count: 1,
                  windowEndAt: new Date(
                    now.getTime() + this.windowSeconds * 1000,
                  ),
                },
              });
              return { allowed: true } as const;
            }

            if (bucket.count >= limit) {
              return {
                allowed: false,
                retryAfterSeconds: Math.max(
                  1,
                  Math.ceil(
                    (bucket.windowEndAt.getTime() - now.getTime()) / 1000,
                  ),
                ),
              } as const;
            }

            await transaction.accountDeletionCancellationRateLimit.update({
              where: { key },
              data: { count: { increment: 1 } },
            });
            return { allowed: true } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const uniqueConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if ((uniqueConflict || isTransactionConflict(error)) && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    return { allowed: false, retryAfterSeconds: this.windowSeconds };
  }
}

export type AccountDeletionCancellationRateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };
