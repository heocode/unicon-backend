import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { NotificationService } from '../../../notifications/services/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { PasswordService } from '../../password/services/password.service';
import { SecureTokenService } from '../../services/secure-token.service';
import { RecoveryRateLimitService } from './recovery-rate-limit.service';
import { RecoveryRateLimitError } from '../errors/recovery-rate-limit.error';

import type { ForgotPasswordDto } from '../../dtos/forgot-password.dto';
import type { ResetPasswordDto } from '../../dtos/reset-password.dto';
import type { SessionMetadata } from '../../types/session-metadata.type';

const GENERIC_RESPONSE = {
  message:
    'If an eligible account exists, password reset instructions will be sent.',
} as const;

@Injectable()
export class PasswordRecoveryService {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private readonly tokenTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly secureTokenService: SecureTokenService,
    private readonly securityEventService: SecurityEventService,
    private readonly notificationService: NotificationService,
    private readonly rateLimitService: RecoveryRateLimitService,
    configService: ConfigService,
  ) {
    this.tokenTtlSeconds = configService.getOrThrow<number>(
      'PASSWORD_RESET_TOKEN_TTL_SECONDS',
    );
  }

  async requestReset(dto: ForgotPasswordDto, metadata: SessionMetadata) {
    const ipLimit = await this.rateLimitService.consumeIp(metadata.ipAddress);
    if (!ipLimit.allowed) {
      throw new RecoveryRateLimitError(ipLimit.retryAfterSeconds);
    }

    const emailLimit = await this.rateLimitService.consumeEmail(dto.email);
    if (!emailLimit.allowed) {
      throw new RecoveryRateLimitError(emailLimit.retryAfterSeconds);
    }

    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, status: 'ACTIVE', emailVerified: true },
      select: { id: true },
    });
    if (!user) return GENERIC_RESPONSE;

    const token = this.secureTokenService.generateWithSeconds(
      this.tokenTtlSeconds,
    );
    const now = new Date();
    const snapshot = this.securityEventService.snapshotFromMetadata(metadata);

    const record = await this.prisma.$transaction(async (transaction) => {
      await transaction.passwordResetToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
        },
        data: { invalidatedAt: now },
      });
      const created = await transaction.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: token.hashedToken,
          expiresAt: token.expiresAt,
        },
        select: { id: true },
      });
      await this.securityEventService.record(
        {
          type: 'PASSWORD_RESET_REQUESTED',
          userId: user.id,
          occurredAt: now,
          ...snapshot,
        },
        transaction,
      );
      return created;
    });

    try {
      await this.notificationService.sendPasswordResetRequestNotification(
        user.id,
        record.id,
        token.token,
        this.tokenTtlSeconds,
      );
    } catch (error) {
      this.logNotificationFailure(error);
    }

    return GENERIC_RESPONSE;
  }

  async reset(dto: ResetPasswordDto, metadata: SessionMetadata) {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException({
        code: 'PASSWORDS_DO_NOT_MATCH',
        message: 'The new passwords do not match.',
      });
    }

    const tokenHash = this.secureTokenService.hash(dto.token);
    const now = new Date();
    const token = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        invalidatedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE', emailVerified: true },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { passwordHash: true } },
      },
    });
    if (!token) this.throwInvalidToken();

    const passwordHash = await this.passwordService.hash(dto.newPassword);
    const snapshot = this.securityEventService.snapshotFromMetadata(metadata);

    const result = await this.prisma.$transaction(async (transaction) => {
      const consumed = await transaction.passwordResetToken.updateMany({
        where: {
          id: token.id,
          userId: token.userId,
          tokenHash,
          usedAt: null,
          invalidatedAt: null,
          expiresAt: { gt: now },
          user: { status: 'ACTIVE', emailVerified: true },
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) this.throwInvalidToken();

      const updated = await transaction.user.updateMany({
        where: {
          id: token.userId,
          status: 'ACTIVE',
          emailVerified: true,
          passwordHash: token.user.passwordHash,
        },
        data: { passwordHash },
      });
      if (updated.count !== 1) {
        throw new ConflictException({
          code: 'PASSWORD_CHANGED_CONCURRENTLY',
          message: 'The password was changed by another request.',
        });
      }

      await transaction.passwordResetToken.updateMany({
        where: {
          userId: token.userId,
          id: { not: token.id },
          usedAt: null,
          invalidatedAt: null,
        },
        data: { invalidatedAt: now },
      });
      const revoked = await transaction.session.updateMany({
        where: {
          userId: token.userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      const event = await this.securityEventService.record(
        {
          type: 'PASSWORD_RESET_COMPLETED',
          userId: token.userId,
          affectedSessionCount: revoked.count,
          occurredAt: now,
          ...snapshot,
        },
        transaction,
      );
      return { revokedSessionsCount: revoked.count, eventId: event.id };
    });

    try {
      await this.notificationService.sendPasswordResetCompletedNotification(
        token.userId,
        result.eventId,
      );
    } catch (error) {
      this.logNotificationFailure(error);
    }

    return {
      message: 'Password reset successfully.',
      revokedSessionsCount: result.revokedSessionsCount,
    };
  }

  async deleteExpiredTokens(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.passwordResetToken.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return result.count;
  }

  private throwInvalidToken(): never {
    throw new BadRequestException({
      code: 'PASSWORD_RESET_TOKEN_INVALID',
      message: 'The password reset token is invalid or expired.',
    });
  }

  private logNotificationFailure(error: unknown): void {
    this.logger.error(
      'Failed to dispatch a password-reset notification.',
      error instanceof Error ? error.stack : undefined,
    );
  }
}
