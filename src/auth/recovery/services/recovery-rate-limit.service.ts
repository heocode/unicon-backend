import { createHmac } from 'crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../../generated/prisma/client';

import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class RecoveryRateLimitService {
  private readonly windowSeconds: number;
  private readonly emailLimit: number;
  private readonly ipLimit: number;
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.windowSeconds = configService.getOrThrow<number>(
      'PASSWORD_RESET_REQUEST_WINDOW_SECONDS',
    );
    this.emailLimit = configService.getOrThrow<number>(
      'PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL',
    );
    this.ipLimit = configService.getOrThrow<number>(
      'PASSWORD_RESET_REQUEST_LIMIT_PER_IP',
    );
    this.secret = configService.getOrThrow<string>(
      'PASSWORD_RESET_RATE_LIMIT_SECRET',
    );
  }

  consumeEmail(email: string): Promise<RecoveryRateLimitResult> {
    return this.consume('email', email, this.emailLimit);
  }

  consumeIp(ipAddress: string | undefined): Promise<RecoveryRateLimitResult> {
    return this.consume('ip', ipAddress ?? 'unknown', this.ipLimit);
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.passwordResetRateLimit.deleteMany({
      where: { windowEndAt: { lte: now } },
    });
    return result.count;
  }

  private async consume(
    scope: string,
    value: string,
    limit: number,
  ): Promise<RecoveryRateLimitResult> {
    const key = `${scope}:${createHmac('sha256', this.secret).update(value).digest('hex')}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction<RecoveryRateLimitResult>(
          async (transaction) => {
            const now = new Date();
            const bucket = await transaction.passwordResetRateLimit.findUnique({
              where: { key },
            });

            if (!bucket || bucket.windowEndAt <= now) {
              await transaction.passwordResetRateLimit.upsert({
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
              return { allowed: true };
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
              };
            }

            await transaction.passwordResetRateLimit.update({
              where: { key },
              data: { count: { increment: 1 } },
            });
            return { allowed: true };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (this.isConflict(error) && attempt < 2) continue;
        throw error;
      }
    }

    return { allowed: false, retryAfterSeconds: this.windowSeconds };
  }

  private isConflict(error: unknown): boolean {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === 'P2002' || error.code === 'P2034')
    ) {
      return true;
    }
    if (!(error instanceof Error) || error.name !== 'DriverAdapterError') {
      return false;
    }
    const cause = error.cause;
    return (
      typeof cause === 'object' &&
      cause !== null &&
      'kind' in cause &&
      cause.kind === 'TransactionWriteConflict'
    );
  }
}

export type RecoveryRateLimitResult =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };
