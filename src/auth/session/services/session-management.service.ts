// NestJS
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import { Prisma } from '../../../generated/prisma/client';

// Internal services
import { PrismaService } from '../../../prisma/prisma.service';
import { SecurityEventService } from '../../../security/services/security-event.service';

// Internal types
import type { SessionMetadata } from '../../types/session-metadata.type';

@Injectable()
export class SessionManagementService {
  private readonly managementCooldownSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEventService: SecurityEventService,
    configService: ConfigService,
  ) {
    this.managementCooldownSeconds = configService.getOrThrow<number>(
      'SESSION_MANAGEMENT_COOLDOWN_SECONDS',
    );
  }

  async rename(
    userId: string,
    currentSessionId: string,
    targetSessionId: string,
    sessionName: string | null,
  ): Promise<{ id: string; sessionName: string | null }> {
    const now = new Date();
    const currentSession = await this.findActiveCurrentSession(
      userId,
      currentSessionId,
      now,
    );
    this.assertManagementAvailable(currentSession.createdAt, now);

    const result = await this.prisma.session.updateMany({
      where: {
        id: targetSessionId,
        userId,
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        sessionName,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'Active session not found.',
      });
    }

    return { id: targetSessionId, sessionName };
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const session = await transaction.session.findFirst({
        where: { id: sessionId, userId, revokedAt: null },
        select: this.securitySnapshotSelect,
      });

      if (!session) {
        throw new UnauthorizedException('Access Denied. Session not found.');
      }

      const now = new Date();
      const result = await transaction.session.updateMany({
        where: { id: sessionId, userId, revokedAt: null },
        data: { revokedAt: now },
      });

      if (result.count === 0) {
        throw new UnauthorizedException('Access Denied. Session not found.');
      }

      await this.securityEventService.record(
        {
          type: 'SESSION_REVOKED',
          reason: 'LOGOUT',
          userId,
          actorSessionId: sessionId,
          subjectSessionId: sessionId,
          occurredAt: now,
          ...this.toSecuritySnapshot(session),
        },
        transaction,
      );
    });
  }

  async revokeSelected(
    userId: string,
    currentSessionId: string,
    targetSessionId: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const currentSession = await this.findActiveCurrentSession(
        userId,
        currentSessionId,
        now,
        transaction,
      );

      if (targetSessionId !== currentSessionId) {
        this.assertManagementAvailable(currentSession.createdAt, now);
      }

      const result = await transaction.session.updateMany({
        where: {
          id: targetSessionId,
          userId,
          revokedAt: null,
          expiresAt: {
            gt: now,
          },
        },
        data: {
          revokedAt: now,
        },
      });

      if (result.count === 0) {
        throw new NotFoundException({
          code: 'SESSION_NOT_FOUND',
          message: 'Active session not found.',
        });
      }

      await this.securityEventService.record(
        {
          type: 'SESSION_REVOKED',
          reason: 'SESSION_MANAGEMENT',
          userId,
          actorSessionId: currentSessionId,
          subjectSessionId: targetSessionId,
          occurredAt: now,
          ...this.toSecuritySnapshot(currentSession),
        },
        transaction,
      );
    });
  }

  async revokeOthers(
    userId: string,
    currentSessionId: string,
  ): Promise<{ revokedSessionsCount: number }> {
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const currentSession = await this.findActiveCurrentSession(
        userId,
        currentSessionId,
        now,
        transaction,
      );
      this.assertManagementAvailable(currentSession.createdAt, now);

      const result = await transaction.session.updateMany({
        where: {
          userId,
          id: {
            not: currentSessionId,
          },
          revokedAt: null,
          expiresAt: {
            gt: now,
          },
        },
        data: {
          revokedAt: now,
        },
      });

      await this.securityEventService.record(
        {
          type: 'OTHER_SESSIONS_REVOKED',
          reason: 'SESSION_MANAGEMENT',
          userId,
          actorSessionId: currentSessionId,
          affectedSessionCount: result.count,
          occurredAt: now,
          ...this.toSecuritySnapshot(currentSession),
        },
        transaction,
      );

      return { revokedSessionsCount: result.count };
    });
  }

  private async findActiveCurrentSession(
    userId: string,
    currentSessionId: string,
    now: Date,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const currentSession = await client.session.findFirst({
      where: {
        id: currentSessionId,
        userId,
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
        user: {
          status: 'ACTIVE',
        },
      },
      select: { createdAt: true, ...this.securitySnapshotSelect },
    });

    if (!currentSession) {
      throw new UnauthorizedException('Access Denied. Session unavailable.');
    }

    return currentSession;
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

  private assertManagementAvailable(createdAt: Date, now: Date): void {
    const manageAvailableAt = this.getManagementAvailableAt(createdAt);

    if (manageAvailableAt > now) {
      throw new ForbiddenException({
        code: 'SESSION_TOO_FRESH',
        message: 'This session is too new to manage sessions.',
        managementAvailableAt: manageAvailableAt,
        retryAfterSeconds: Math.ceil(
          (manageAvailableAt.getTime() - now.getTime()) / 1000,
        ),
      });
    }
  }

  private getManagementAvailableAt(createdAt: Date): Date {
    return new Date(
      createdAt.getTime() + this.managementCooldownSeconds * 1000,
    );
  }
}
