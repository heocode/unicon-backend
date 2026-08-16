// NestJS
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal services
import { NotificationService } from '../../../notifications/services/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';

// Internal types
import type { SessionMetadata } from '../../types/session-metadata.type';
import type { AuthTokens } from '../types/session-tokens.type';

@Injectable()
export class SessionRefreshService {
  private readonly logger = new Logger(SessionRefreshService.name);
  private readonly inactivityTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly secureTokenService: SecureTokenService,
    private readonly securityEventService: SecurityEventService,
    private readonly riskAnalysisService: RiskAnalysisService,
    private readonly notificationService: NotificationService,
    configService: ConfigService,
  ) {
    this.inactivityTtlSeconds = configService.getOrThrow<number>(
      'SESSION_INACTIVITY_TTL_SECONDS',
    );
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
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
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

  private getNextExpiration(now: Date): Date {
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.inactivityTtlSeconds;

    return new Date(expiresAtSeconds * 1000);
  }

  private async recordRefreshTokenReuse(
    userId: string,
    sessionId: string,
    snapshot: Parameters<SessionRefreshService['toSecuritySnapshot']>[0],
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
