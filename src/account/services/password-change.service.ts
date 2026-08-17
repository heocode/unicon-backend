// NestJS
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

// Internal services
import { PasswordService } from '../../auth/password/services/password.service';
import { NotificationService } from '../../notifications/services/notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SecurityEventService } from '../../security/services/security-event.service';

// Internal DTOs
import type { ChangePasswordDto } from '../dtos/change-password.dto';
import type { PasswordChangeResponseDto } from '../dtos/password-change-response.dto';

// Internal types
import type { SessionMetadata } from '../../auth/types/session-metadata.type';

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
      throw new UnauthorizedException({
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
        select: this.securitySnapshotSelect,
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
          ...this.toSecuritySnapshot(currentSession),
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

  private readonly securitySnapshotSelect = {
    ipAddress: true,
    userAgent: true,
    deviceModel: true,
    platform: true,
    osVersion: true,
    appVersion: true,
    locationCountryCode: true,
    locationCity: true,
  } as const;

  private toSecuritySnapshot(snapshot: {
    ipAddress?: string | null;
    userAgent?: string | null;
    deviceModel?: string | null;
    platform?: SessionMetadata['platform'] | null;
    osVersion?: string | null;
    appVersion?: string | null;
    locationCountryCode?: string | null;
    locationCity?: string | null;
  }) {
    return {
      ipAddress: snapshot.ipAddress ?? undefined,
      userAgent: snapshot.userAgent ?? undefined,
      deviceModel: snapshot.deviceModel ?? undefined,
      platform: snapshot.platform ?? undefined,
      osVersion: snapshot.osVersion ?? undefined,
      appVersion: snapshot.appVersion ?? undefined,
      locationCountryCode: snapshot.locationCountryCode ?? undefined,
      locationCity: snapshot.locationCity ?? undefined,
    };
  }
}
