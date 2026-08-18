// NestJS
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

// Internal services
import { PasswordService } from '../../auth/password/services/password.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import {
  SECURITY_EVENT_SNAPSHOT_SELECT,
  toSecurityEventSnapshot,
} from '../../security/utils/security-event-snapshot.util';

// Internal DTOs
import type { ChangePasswordDto } from '../dtos/change-password.dto';
import type { PasswordChangeResponseDto } from '../dtos/password-change-response.dto';

@Injectable()
export class PasswordChangeService {
  private readonly logger = new Logger(PasswordChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly securityEventService: SecurityEventService,
    private readonly notificationService: NotificationService,
  ) {}

  async change(
    userId: string,
    currentSessionId: string,
    dto: ChangePasswordDto,
  ): Promise<PasswordChangeResponseDto> {
    if (dto.newPassword !== dto.confirmNewPassword) {
      throw new BadRequestException({
        code: 'PASSWORDS_DO_NOT_MATCH',
        message: 'The new passwords do not match.',
      });
    }

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

    if (
      await this.passwordService.compare(dto.newPassword, user.passwordHash)
    ) {
      throw new BadRequestException({
        code: 'NEW_PASSWORD_SAME_AS_CURRENT',
        message: 'The new password must differ from the current password.',
      });
    }

    const nextPasswordHash = await this.passwordService.hash(dto.newPassword);
    const now = new Date();

    const result = await this.prisma.$transaction(async (transaction) => {
      const currentSession = await transaction.session.findFirst({
        where: {
          id: currentSessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
          user: { status: 'ACTIVE' },
        },
        select: SECURITY_EVENT_SNAPSHOT_SELECT,
      });

      if (!currentSession) {
        throw new UnauthorizedException({
          code: 'SESSION_UNAVAILABLE',
          message: 'The current session is unavailable.',
        });
      }

      const passwordUpdate = await transaction.user.updateMany({
        where: {
          id: userId,
          passwordHash: user.passwordHash,
          status: 'ACTIVE',
        },
        data: { passwordHash: nextPasswordHash },
      });

      if (passwordUpdate.count !== 1) {
        throw new ConflictException({
          code: 'PASSWORD_CHANGED_CONCURRENTLY',
          message: 'The password was changed by another request.',
        });
      }

      const revokedSessions = await transaction.session.updateMany({
        where: {
          userId,
          id: { not: currentSessionId },
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });

      const securityEvent = await this.securityEventService.record(
        {
          type: 'PASSWORD_CHANGED',
          userId,
          actorSessionId: currentSessionId,
          affectedSessionCount: revokedSessions.count,
          occurredAt: now,
          ...toSecurityEventSnapshot(currentSession),
        },
        transaction,
      );

      return {
        revokedSessionsCount: revokedSessions.count,
        securityEventId: securityEvent.id,
      };
    });

    try {
      await this.notificationService.sendPasswordChangedNotification(
        userId,
        result.securityEventId,
      );
    } catch (error) {
      this.logger.error(
        'Failed to dispatch a password-change notification.',
        error instanceof Error ? error.stack : undefined,
      );
    }

    return {
      message: 'Password changed successfully.',
      revokedSessionsCount: result.revokedSessionsCount,
    };
  }
}
