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
import {
  SECURITY_EVENT_SNAPSHOT_SELECT,
  toSecurityEventSnapshot,
} from '../../../security/utils/security-event-snapshot.util';

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
        select: SECURITY_EVENT_SNAPSHOT_SELECT,
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
          ...toSecurityEventSnapshot(session),
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
          ...toSecurityEventSnapshot(currentSession),
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
          ...toSecurityEventSnapshot(currentSession),
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
      select: { createdAt: true, ...SECURITY_EVENT_SNAPSHOT_SELECT },
    });

    if (!currentSession) {
      throw new UnauthorizedException('Access Denied. Session unavailable.');
    }

    return currentSession;
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
