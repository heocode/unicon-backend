import { randomBytes } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { AccountDeletionNotificationService } from '../../notifications/services/account-deletion-notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isTransactionConflict } from '../../prisma/utils/is-transaction-conflict.util';
import { SecurityEventService } from '../../security/services/security-event.service';
import { PasswordService } from '../../auth/password/services/password.service';

type FinalizationCandidate = {
  id: string;
  email: string;
  deletionScheduledAt: Date;
};

export type AccountDeletionFinalizationSummary = {
  finalizedAccounts: number;
  retriedCompletionDeliveries: number;
};

@Injectable()
export class AccountDeletionFinalizationService {
  private readonly logger = new Logger(AccountDeletionFinalizationService.name);
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly securityEventService: SecurityEventService,
    private readonly notificationService: AccountDeletionNotificationService,
    configService: ConfigService,
  ) {
    this.batchSize = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE',
    );
  }

  async run(): Promise<AccountDeletionFinalizationSummary> {
    const retriedCompletionDeliveries =
      await this.notificationService.retryDeletionCompleted(this.batchSize);
    let finalizedAccounts = 0;

    while (true) {
      const finalizedInBatch = await this.finalizeBatch();
      finalizedAccounts += finalizedInBatch;
      if (finalizedInBatch < this.batchSize) break;
    }

    return { finalizedAccounts, retriedCompletionDeliveries };
  }

  async finalizeBatch(now: Date = new Date()): Promise<number> {
    let finalized = 0;

    for (let index = 0; index < this.batchSize; index++) {
      const result = await this.finalizeNext(now);
      if (!result) break;
      finalized++;

      try {
        await this.notificationService.sendPreparedDeletionCompleted(
          result.notificationDeliveryId,
        );
      } catch (error) {
        this.logger.error(
          'Failed to dispatch a prepared account-deleted notification.',
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    return finalized;
  }

  private async finalizeNext(
    now: Date,
  ): Promise<{ notificationDeliveryId: string } | null> {
    const discardedPasswordHash = await this.passwordService.hash(
      randomBytes(32).toString('hex'),
    );

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const candidates = await transaction.$queryRaw<
              FinalizationCandidate[]
            >(Prisma.sql`
              SELECT "id", "email", "deletionScheduledAt"
              FROM "User"
              WHERE "status" = 'DELETION_SCHEDULED'::"UserStatus"
                AND "deletionScheduledAt" <= ${now}
              ORDER BY "deletionScheduledAt" ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            `);
            const candidate = candidates[0];
            if (!candidate) return null;

            const securityEvent = await this.securityEventService.record(
              {
                type: 'ACCOUNT_DELETED',
                reason: 'GRACE_PERIOD_EXPIRED',
                userId: candidate.id,
                occurredAt: now,
              },
              transaction,
            );
            const delivery =
              await this.notificationService.prepareDeletionCompleted(
                transaction,
                {
                  userId: candidate.id,
                  securityEventId: securityEvent.id,
                  recipient: candidate.email,
                  occurredAt: now,
                },
              );

            await transaction.session.deleteMany({
              where: { userId: candidate.id },
            });
            await transaction.passwordResetToken.deleteMany({
              where: { userId: candidate.id },
            });

            const updated = await transaction.user.updateMany({
              where: {
                id: candidate.id,
                status: 'DELETION_SCHEDULED',
                deletionScheduledAt: { lte: now },
              },
              data: {
                status: 'DELETED',
                role: 'MEMBER',
                email: `deleted+${candidate.id}@deleted.invalid`,
                username: `deleted_${candidate.id}`,
                emailVerified: false,
                passwordHash: discardedPasswordHash,
                lastLoginAt: null,
                loginAttempts: 0,
                lockoutUntil: null,
                verificationEmailSentAt: null,
                hashedVerificationToken: null,
                verificationTokenExpires: null,
                deletionRequestedAt: null,
                deletionScheduledAt: null,
                deletedAt: now,
              },
            });

            if (updated.count !== 1) {
              throw new Error(
                'Account deletion state changed during finalization.',
              );
            }

            return { notificationDeliveryId: delivery.id };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isTransactionConflict(error) && attempt < 2) continue;
        throw error;
      }
    }

    return null;
  }
}
