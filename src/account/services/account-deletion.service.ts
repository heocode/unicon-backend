// NestJS
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import { Prisma } from '../../generated/prisma/client';

// Internal services
import { PasswordService } from '../../auth/password/services/password.service';
import { SessionCreationService } from '../../auth/session/services/session-creation.service';
import { PrismaService } from '../../prisma/prisma.service';
import { isTransactionConflict } from '../../prisma/utils/is-transaction-conflict.util';
import { lockUserForUpdate } from '../../prisma/utils/lock-user-for-update.util';
import { SecurityEventService } from '../../security/services/security-event.service';
import { AccountDeletionNotificationService } from '../../notifications/services/account-deletion-notification.service';
import { AccountDeletionCancellationRateLimitError } from '../errors/account-deletion-cancellation-rate-limit.error';
import { AccountDeletionCancellationRateLimitService } from './account-deletion-cancellation-rate-limit.service';
import {
  SECURITY_EVENT_SNAPSHOT_SELECT,
  toSecurityEventSnapshot,
} from '../../security/utils/security-event-snapshot.util';

// Internal DTOs
import type { AccountDeletionResponseDto } from '../dtos/account-deletion-response.dto';
import type { AccountDeletionCancelledResponseDto } from '../dtos/account-deletion-cancelled-response.dto';
import type { CancelAccountDeletionDto } from '../dtos/cancel-account-deletion.dto';
import type { RequestAccountDeletionDto } from '../dtos/request-account-deletion.dto';
import type { SessionMetadata } from '../../auth/types/session-metadata.type';

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly gracePeriodSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly sessionCreationService: SessionCreationService,
    private readonly securityEventService: SecurityEventService,
    private readonly cancellationRateLimitService: AccountDeletionCancellationRateLimitService,
    private readonly notificationService: AccountDeletionNotificationService,
    configService: ConfigService,
  ) {
    this.gracePeriodSeconds = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_GRACE_PERIOD_SECONDS',
    );
  }

  async request(
    userId: string,
    currentSessionId: string,
    dto: RequestAccountDeletionDto,
  ): Promise<AccountDeletionResponseDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: 'ACTIVE' },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new ForbiddenException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'The account is unavailable.',
      });
    }

    if (
      !(await this.passwordService.compare(
        dto.currentPassword,
        user.passwordHash,
      ))
    ) {
      throw new UnauthorizedException({
        code: 'CURRENT_PASSWORD_INVALID',
        message: 'The current password is invalid.',
      });
    }

    const now = new Date();
    const deletionScheduledAt = new Date(
      now.getTime() + this.gracePeriodSeconds * 1000,
    );

    const result = await this.prisma.$transaction(async (transaction) => {
      const lockedUser = await lockUserForUpdate(transaction, userId);

      if (
        lockedUser?.status === 'DELETION_SCHEDULED' &&
        lockedUser.deletionScheduledAt
      ) {
        return {
          response: this.toResponse(lockedUser.deletionScheduledAt),
          securityEventId: null,
        };
      }

      if (
        !lockedUser ||
        lockedUser.status !== 'ACTIVE' ||
        lockedUser.passwordHash !== user.passwordHash
      ) {
        throw new ConflictException({
          code: 'ACCOUNT_STATE_CHANGED',
          message: 'The account state changed while processing the request.',
        });
      }

      const currentSession = await transaction.session.findFirst({
        where: {
          id: currentSessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: SECURITY_EVENT_SNAPSHOT_SELECT,
      });

      if (!currentSession) {
        throw new UnauthorizedException({
          code: 'SESSION_UNAVAILABLE',
          message: 'The current session is unavailable.',
        });
      }

      const updated = await transaction.user.updateMany({
        where: {
          id: userId,
          status: 'ACTIVE',
          passwordHash: user.passwordHash,
        },
        data: {
          status: 'DELETION_SCHEDULED',
          deletionRequestedAt: now,
          deletionScheduledAt,
          hashedVerificationToken: null,
          verificationTokenExpires: null,
          verificationEmailSentAt: null,
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException({
          code: 'ACCOUNT_STATE_CHANGED',
          message: 'The account state changed while processing the request.',
        });
      }

      const revokedSessions = await transaction.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      await transaction.passwordResetToken.updateMany({
        where: {
          userId,
          usedAt: null,
          invalidatedAt: null,
        },
        data: { invalidatedAt: now },
      });

      const securityEvent = await this.securityEventService.record(
        {
          type: 'ACCOUNT_DELETION_REQUESTED',
          userId,
          actorSessionId: currentSessionId,
          affectedSessionCount: revokedSessions.count,
          occurredAt: now,
          ...toSecurityEventSnapshot(currentSession),
        },
        transaction,
      );

      return {
        response: this.toResponse(deletionScheduledAt),
        securityEventId: securityEvent.id,
      };
    });

    if (result.securityEventId) {
      const securityEventId = result.securityEventId;
      await this.dispatchNotification(() =>
        this.notificationService.sendDeletionRequested(
          userId,
          securityEventId,
          result.response.deletionScheduledAt,
        ),
      );
    }

    return result.response;
  }

  async cancel(
    dto: CancelAccountDeletionDto,
    metadata: SessionMetadata,
  ): Promise<AccountDeletionCancelledResponseDto> {
    const ipLimit = await this.cancellationRateLimitService.consumeIp(
      metadata.ipAddress,
    );
    if (!ipLimit.allowed) {
      throw new AccountDeletionCancellationRateLimitError(
        ipLimit.retryAfterSeconds,
      );
    }

    const emailLimit = await this.cancellationRateLimitService.consumeEmail(
      dto.email,
    );
    if (!emailLimit.allowed) {
      throw new AccountDeletionCancellationRateLimitError(
        emailLimit.retryAfterSeconds,
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        deletionScheduledAt: true,
      },
    });

    if (
      !user ||
      !(await this.passwordService.compare(
        dto.currentPassword,
        user.passwordHash,
      ))
    ) {
      this.throwInvalidCredentials();
    }

    if (user.status === 'ACTIVE') {
      this.throwAlreadyCancelled();
    }

    if (user.status !== 'DELETION_SCHEDULED') {
      this.throwInvalidCredentials();
    }

    const now = new Date();

    if (!user.deletionScheduledAt || user.deletionScheduledAt <= now) {
      this.throwGracePeriodExpired();
    }

    const expectedDeletionScheduledAt = user.deletionScheduledAt;
    const preparedSession = await this.sessionCreationService.prepare(
      user.id,
      metadata,
    );
    const snapshot = this.securityEventService.snapshotFromMetadata(metadata);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.prisma.$transaction(
          async (transaction) => {
            const lockedUser = await lockUserForUpdate(transaction, user.id);
            const transactionNow = new Date();

            if (lockedUser?.status === 'ACTIVE') {
              this.throwAlreadyCancelled();
            }

            if (
              !lockedUser ||
              lockedUser.status !== 'DELETION_SCHEDULED' ||
              lockedUser.passwordHash !== user.passwordHash ||
              !lockedUser.deletionScheduledAt ||
              lockedUser.deletionScheduledAt.getTime() !==
                expectedDeletionScheduledAt.getTime()
            ) {
              this.throwAccountStateChanged();
            }

            if (lockedUser.deletionScheduledAt <= transactionNow) {
              this.throwGracePeriodExpired();
            }

            const updated = await transaction.user.updateMany({
              where: {
                id: user.id,
                status: 'DELETION_SCHEDULED',
                passwordHash: user.passwordHash,
                deletionScheduledAt: expectedDeletionScheduledAt,
              },
              data: {
                status: 'ACTIVE',
                deletionRequestedAt: null,
                deletionScheduledAt: null,
              },
            });

            if (updated.count !== 1) {
              this.throwAccountStateChanged();
            }

            const sessionCreation =
              await this.sessionCreationService.createInTransaction(
                transaction,
                preparedSession,
              );
            this.sessionCreationService.assertCreated(sessionCreation);

            const securityEvent = await this.securityEventService.record(
              {
                type: 'ACCOUNT_DELETION_CANCELLED',
                userId: user.id,
                occurredAt: transactionNow,
                ...snapshot,
              },
              transaction,
            );

            return {
              session: preparedSession.result,
              securityEventId: securityEvent.id,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        await this.dispatchNotification(() =>
          this.notificationService.sendDeletionCancelled(
            user.id,
            result.securityEventId,
          ),
        );

        return {
          status: 'ACTIVE',
          deletionCancelled: true,
          accessToken: result.session.accessToken,
          refreshToken: result.session.refreshToken,
        };
      } catch (error) {
        if (isTransactionConflict(error) && attempt < 2) {
          continue;
        }

        throw error;
      }
    }

    throw new ConflictException({
      code: 'ACCOUNT_STATE_CHANGED',
      message: 'The account state changed while processing the request.',
    });
  }

  private toResponse(deletionScheduledAt: Date): AccountDeletionResponseDto {
    return {
      status: 'DELETION_SCHEDULED',
      deletionScheduledAt,
      gracePeriodSeconds: this.gracePeriodSeconds,
    };
  }

  private async dispatchNotification(send: () => Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      this.logger.error(
        'Failed to dispatch an account-deletion notification.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private throwInvalidCredentials(): never {
    throw new UnauthorizedException({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password.',
    });
  }

  private throwAlreadyCancelled(): never {
    throw new ConflictException({
      code: 'ACCOUNT_DELETION_ALREADY_CANCELLED',
      message: 'Account deletion has already been cancelled. Please sign in.',
    });
  }

  private throwGracePeriodExpired(): never {
    throw new ConflictException({
      code: 'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
      message: 'The account deletion grace period has expired.',
    });
  }

  private throwAccountStateChanged(): never {
    throw new ConflictException({
      code: 'ACCOUNT_STATE_CHANGED',
      message: 'The account state changed while processing the request.',
    });
  }
}
