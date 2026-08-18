// NestJS
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal services
import { NotificationService } from '../../../notifications/services/notification.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import {
  SECURITY_EVENT_SNAPSHOT_SELECT,
  toSecurityEventSnapshot,
  type SecurityEventSnapshotSource,
} from '../../../security/utils/security-event-snapshot.util';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';

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
        ...SECURITY_EVENT_SNAPSHOT_SELECT,
      },
    });

    if (!session) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'The refresh token is invalid.',
      });
    }

    const now = new Date();

    if (session.expiresAt <= now) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'The refresh token has expired.',
      });
    }

    if (session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'The refresh token is invalid.',
      });
    }

    const incomingTokenHash = this.secureTokenService.hash(refreshToken);

    if (incomingTokenHash !== session.hashedRefreshToken) {
      await this.recordRefreshTokenReuse(userId, session.id, session);
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REUSED',
        message: 'The refresh token has already been used.',
      });
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
      const wasRotated = await this.hasRefreshTokenBeenRotated(
        userId,
        session.id,
        incomingTokenHash,
        now,
      );

      if (wasRotated) {
        await this.recordRefreshTokenReuse(userId, session.id, session);
      }

      throw new UnauthorizedException({
        code: wasRotated ? 'REFRESH_TOKEN_REUSED' : 'REFRESH_TOKEN_INVALID',
        message: 'The refresh token is invalid or has already been used.',
      });
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
    snapshot: SecurityEventSnapshotSource,
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
        ...toSecurityEventSnapshot(snapshot),
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
}
