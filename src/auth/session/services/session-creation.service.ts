// NestJS
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Node.js
import { randomUUID } from 'crypto';

// Prisma
import { Prisma } from '../../../generated/prisma/client';

// Internal services
import { GeoIpService } from '../../../geo-ip/geo-ip.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { isTransactionConflict } from '../../../prisma/utils/is-transaction-conflict.util';
import { lockUserForUpdate } from '../../../prisma/utils/lock-user-for-update.util';
import { RiskAnalysisService } from '../../../security/services/risk-analysis.service';
import { SecurityEventService } from '../../../security/services/security-event.service';
import { toSecurityEventSnapshot } from '../../../security/utils/security-event-snapshot.util';
import { JwtTokenService } from '../../services/jwt-token.service';
import { SecureTokenService } from '../../services/secure-token.service';

// Internal types
import type { SessionMetadata } from '../../types/session-metadata.type';
import type {
  CreatedSession,
  PreparedSession,
  SessionCreationResult,
} from '../types/session-tokens.type';

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
    const preparedSession = await this.prepare(userId, metadata);
    let result: SessionCreationResult | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await this.prisma.$transaction(
          (transaction) =>
            this.createInTransaction(transaction, preparedSession),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (isTransactionConflict(error) && attempt < 2) {
          continue;
        }

        throw error;
      }
    }

    this.assertCreated(result);

    return preparedSession.result;
  }

  async prepare(
    userId: string,
    metadata: SessionMetadata = { platform: 'UNKNOWN' },
  ): Promise<PreparedSession> {
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

    return {
      result: {
        accessToken: generatedTokens.accessToken,
        refreshToken: generatedTokens.refreshToken,
        sessionId,
      },
      data: {
        id: sessionId,
        userId,
        hashedRefreshToken,
        expiresAt,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        deviceModelIdentifier: metadata.deviceModelIdentifier,
        deviceModel: metadata.deviceModel,
        platform: metadata.platform,
        osVersion: metadata.osVersion,
        appVersion: metadata.appVersion,
        locationCountryCode: location?.countryCode,
        locationCity: location?.city,
      },
      occurredAt: now,
    };
  }

  async createInTransaction(
    transaction: Prisma.TransactionClient,
    preparedSession: PreparedSession,
  ): Promise<SessionCreationResult> {
    const { data, occurredAt } = preparedSession;
    const user = await lockUserForUpdate(transaction, data.userId);

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'The account is unavailable.',
      });
    }

    const activeSessionCount = await transaction.session.count({
      where: {
        userId: data.userId,
        revokedAt: null,
        expiresAt: { gt: occurredAt },
      },
    });

    if (activeSessionCount >= this.activeSessionLimit) {
      await this.securityEventService.record(
        {
          type: 'SESSION_CREATION_FAILED',
          reason: 'ACTIVE_SESSION_LIMIT_REACHED',
          userId: data.userId,
          ...toSecurityEventSnapshot(data),
        },
        transaction,
      );

      return { created: false };
    }

    const snapshot = toSecurityEventSnapshot(data);
    const risk = await this.riskAnalysisService.assessNewSession(
      transaction,
      data.userId,
      snapshot,
      occurredAt,
    );

    await transaction.session.create({ data });
    await this.securityEventService.record(
      {
        type: 'SESSION_CREATED',
        userId: data.userId,
        actorSessionId: data.id,
        subjectSessionId: data.id,
        riskLevel: risk.level ?? undefined,
        riskSignals: risk.signals,
        occurredAt,
        ...snapshot,
      },
      transaction,
    );

    if (risk.level === 'MEDIUM' || risk.level === 'HIGH') {
      await this.securityEventService.record(
        {
          type: 'SUSPICIOUS_ACTIVITY_DETECTED',
          userId: data.userId,
          actorSessionId: data.id,
          subjectSessionId: data.id,
          riskLevel: risk.level,
          riskSignals: risk.signals,
          occurredAt,
          ...snapshot,
        },
        transaction,
      );
    }

    return { created: true };
  }

  assertCreated(result: SessionCreationResult | undefined): void {
    if (!result?.created) {
      throw new ConflictException({
        code: 'SESSION_LIMIT_REACHED',
        message: 'The active session limit has been reached.',
        activeSessionLimit: this.activeSessionLimit,
      });
    }
  }

  private getNextExpiration(now: Date): Date {
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.inactivityTtlSeconds;

    return new Date(expiresAtSeconds * 1000);
  }
}
