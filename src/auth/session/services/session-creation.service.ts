// NestJS
import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Node.js
import { randomUUID } from 'crypto';

// Prisma
import { Prisma } from '../../../generated/prisma/client';

// Internal services
import { GeoIpService } from '../../../geo-ip/geo-ip.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';

// Internal types
import type { SessionMetadata } from '../../types/session-metadata.type';
import type { CreatedSession } from '../types/session-tokens.type';

@Injectable()
export class SessionCreationService {
  private readonly inactivityTtlSeconds: number;
  private readonly activeSessionLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly secureTokenService: SecureTokenService,
    private readonly geoIpService: GeoIpService,
    private readonly securityEventService: SecurityEventService,
    private readonly riskAnalysisService: RiskAnalysisService,
    configService: ConfigService,
  ) {
    this.inactivityTtlSeconds = configService.getOrThrow<number>(
      'SESSION_INACTIVITY_TTL_SECONDS',
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
                expiresAt: { gt: new Date() },
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

            await transaction.session.create({ data: sessionData });
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
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (this.isTransactionConflict(error) && attempt < 2) {
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
