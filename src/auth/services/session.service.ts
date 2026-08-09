// NestJS
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Node.js
import { randomUUID } from 'crypto';

// Prisma
import { Prisma } from '../../generated/prisma/client';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';
import { JwtTokenService } from './jwt-token.service';
import { SecureTokenService } from './secure-token.service';
import { GeoIpService } from '../../geo-ip/geo-ip.service';
import { SecurityEventService } from '../../security/services/security-event.service';
import { RiskAnalysisService } from '../../security/services/risk-analysis.service';
import { NotificationService } from '../../notifications/services/notification.service';

// Internal types
import type { SessionMetadata } from '../types/session-metadata.type';
import type { SessionsResponseDto } from '../dtos/session-response.dto';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

type CreatedSession = AuthTokens & {
  sessionId: string;
};

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private readonly inactivityTtlSeconds: number;
  private readonly managementCooldownSeconds: number;
  private readonly activeSessionLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly secureTokenService: SecureTokenService,
    private readonly geoIpService: GeoIpService,
    private readonly securityEventService: SecurityEventService,
    private readonly riskAnalysisService: RiskAnalysisService,
    private readonly notificationService: NotificationService,
    configService: ConfigService,
  ) {
    this.inactivityTtlSeconds = configService.getOrThrow<number>(
      'SESSION_INACTIVITY_TTL_SECONDS',
    );
    this.managementCooldownSeconds = configService.getOrThrow<number>(
      'SESSION_MANAGEMENT_COOLDOWN_SECONDS',
    );
    this.activeSessionLimit = configService.getOrThrow<number>(
      'SESSION_ACTIVE_LIMIT',
    );
  }

  async create(
    userId: string,
    metadata: SessionMetadata = { platform: 'UNKNOWN' },
  ): Promise<CreatedSession> {
    const now = new Date();
    const sessionId = randomUUID();
    const expiresAt = this.getNextExpiration(now);
    const location = this.geoIpService.lookup(metadata.ipAddress);

    const generatedTokens = await this.jwtTokenService.generateTokens(
      userId,
      sessionId,
      expiresAt,
    );

    const hashedRefreshToken = this.secureTokenService.hash(
      generatedTokens.refreshToken,
    );

    const sessionData = {
      id: sessionId,
      userId,
      hashedRefreshToken,
      expiresAt,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      deviceModel: metadata.deviceModel,
      platform: metadata.platform,
      osVersion: metadata.osVersion,
      appVersion: metadata.appVersion,
      locationCountryCode: location?.countryCode,
      locationCity: location?.city,
    };

    let sessionCreated = false;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        sessionCreated = await this.prisma.$transaction(
          async (transaction) => {
            const activeSessionCount = await transaction.session.count({
              where: {
                userId,
                revokedAt: null,
                expiresAt: {
                  gt: new Date(),
                },
              },
            });

            if (activeSessionCount >= this.activeSessionLimit) {
              await this.securityEventService.record(
                {
                  type: 'SESSION_CREATION_FAILED',
                  reason: 'ACTIVE_SESSION_LIMIT_REACHED',
                  userId,
                  ...this.toSecuritySnapshot(sessionData),
                },
                transaction,
              );

              return false;
            }

            const snapshot = this.toSecuritySnapshot(sessionData);
            const risk = await this.riskAnalysisService.assessNewSession(
              transaction,
              userId,
              snapshot,
              now,
            );

            await transaction.session.create({
              data: sessionData,
            });
            await this.securityEventService.record(
              {
                type: 'SESSION_CREATED',
                userId,
                actorSessionId: sessionId,
                subjectSessionId: sessionId,
                riskLevel: risk.level ?? undefined,
                riskSignals: risk.signals,
                occurredAt: now,
                ...snapshot,
              },
              transaction,
            );

            if (risk.level === 'MEDIUM' || risk.level === 'HIGH') {
              await this.securityEventService.record(
                {
                  type: 'SUSPICIOUS_ACTIVITY_DETECTED',
                  userId,
                  actorSessionId: sessionId,
                  subjectSessionId: sessionId,
                  riskLevel: risk.level,
                  riskSignals: risk.signals,
                  occurredAt: now,
                  ...snapshot,
                },
                transaction,
              );
            }

            return true;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
        break;
      } catch (error) {
        const shouldRetry = this.isTransactionConflict(error) && attempt < 2;

        if (shouldRetry) {
          continue;
        }

        throw error;
      }
    }

    if (!sessionCreated) {
      throw new ConflictException({
        code: 'SESSION_LIMIT_REACHED',
        message: 'The active session limit has been reached.',
        activeSessionLimit: this.activeSessionLimit,
      });
    }

    return {
      accessToken: generatedTokens.accessToken,
      refreshToken: generatedTokens.refreshToken,
      sessionId,
    };
  }

  async refresh(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<AuthTokens> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },
      select: {
        id: true,
        hashedRefreshToken: true,
        expiresAt: true,
        user: {
          select: {
            status: true,
          },
        },
        ipAddress: true,
        userAgent: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
      },
    });

    if (!session) {
      throw new UnauthorizedException('Access Denied. Please log in again.');
    }

    const now = new Date();

    if (session.expiresAt <= now) {
      throw new UnauthorizedException('Access Denied. Session expired.');
    }

    if (session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Access Denied. Account is not active.');
    }

    const incomingTokenHash = this.secureTokenService.hash(refreshToken);

    if (incomingTokenHash !== session.hashedRefreshToken) {
      await this.recordRefreshTokenReuse(userId, session.id, session);
      throw new UnauthorizedException('Access Denied. Invalid token.');
    }

    const nextExpiresAt = this.getNextExpiration(now);

    const generatedTokens = await this.jwtTokenService.generateTokens(
      userId,
      session.id,
      nextExpiresAt,
    );

    const nextRefreshTokenHash = this.secureTokenService.hash(
      generatedTokens.refreshToken,
    );

    const result = await this.prisma.session.updateMany({
      where: {
        id: session.id,
        userId,
        hashedRefreshToken: incomingTokenHash,
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
        user: {
          status: 'ACTIVE',
        },
      },
      data: {
        hashedRefreshToken: nextRefreshTokenHash,
        expiresAt: nextExpiresAt,
        lastActiveAt: now,
      },
    });

    if (result.count !== 1) {
      if (
        await this.hasRefreshTokenBeenRotated(
          userId,
          session.id,
          incomingTokenHash,
          now,
        )
      ) {
        await this.recordRefreshTokenReuse(userId, session.id, session);
      }
      throw new UnauthorizedException(
        'Access Denied. Token already used or session unavailable.',
      );
    }

    return {
      accessToken: generatedTokens.accessToken,
      refreshToken: generatedTokens.refreshToken,
    };
  }

  async assertActive(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
        user: {
          status: 'ACTIVE',
        },
      },
      select: {
        id: true,
      },
    });

    if (!session) {
      throw new UnauthorizedException('Access Denied. Session unavailable.');
    }
  }

  async findActiveByUser(
    userId: string,
    currentSessionId: string,
  ): Promise<SessionsResponseDto> {
    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: {
          gt: now,
        },
      },
      select: {
        id: true,
        sessionName: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastActiveAt: true,
        expiresAt: true,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
    });

    const currentSession = sessions.find(
      (session) => session.id === currentSessionId,
    );

    if (!currentSession) {
      throw new UnauthorizedException('Access Denied. Session unavailable.');
    }

    const managementAvailableAt = this.getManagementAvailableAt(
      currentSession.createdAt,
    );
    const canManageSessions = managementAvailableAt <= now;

    return {
      sessionManagement: {
        canManageSessions,
        managementAvailableAt: canManageSessions ? null : managementAvailableAt,
      },
      sessions: sessions.map((session) => ({
        id: session.id,
        sessionName: session.sessionName,
        device: {
          model: session.deviceModel,
          platform: session.platform,
          osVersion: session.osVersion,
        },
        appVersion: session.appVersion,
        location: session.locationCountryCode
          ? {
              countryCode: session.locationCountryCode,
              city: session.locationCity,
            }
          : null,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        expiresAt: session.expiresAt,
        current: session.id === currentSessionId,
      })),
    };
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

  private getNextExpiration(now: Date): Date {
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.inactivityTtlSeconds;

    return new Date(expiresAtSeconds * 1000);
  }

  private isTransactionConflict(error: unknown): boolean {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
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

  private async recordRefreshTokenReuse(
    userId: string,
    sessionId: string,
    snapshot: Parameters<SessionService['toSecuritySnapshot']>[0],
  ): Promise<void> {
    const risk = this.riskAnalysisService.refreshTokenReuse();

    try {
      await this.securityEventService.record({
        type: 'SUSPICIOUS_ACTIVITY_DETECTED',
        userId,
        actorSessionId: sessionId,
        subjectSessionId: sessionId,
        riskLevel: risk.level ?? undefined,
        riskSignals: risk.signals,
        ...this.toSecuritySnapshot(snapshot),
      });
    } catch (error) {
      this.logger.error(
        'Failed to record refresh-token reuse.',
        error instanceof Error ? error.stack : undefined,
      );
    }

    await this.notificationService.sendSuspiciousActivityNotification(
      userId,
      sessionId,
      risk,
    );
  }

  private async hasRefreshTokenBeenRotated(
    userId: string,
    sessionId: string,
    incomingTokenHash: string,
    now: Date,
  ): Promise<boolean> {
    const currentSession = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
      },
      select: { hashedRefreshToken: true },
    });

    return Boolean(
      currentSession && currentSession.hashedRefreshToken !== incomingTokenHash,
    );
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
