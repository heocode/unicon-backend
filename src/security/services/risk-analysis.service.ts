// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import type { Prisma } from '../../generated/prisma/client';

// Internal types
import type { SecurityEventSnapshot } from '../types/create-security-event.type';
import type { RiskAssessment } from '../types/risk-assessment.type';

@Injectable()
export class RiskAnalysisService {
  private readonly loginFailureWindowSeconds: number;
  private readonly loginFailureThreshold: number;
  private readonly newSessionWindowSeconds: number;
  private readonly newSessionThreshold: number;

  constructor(configService: ConfigService) {
    this.loginFailureWindowSeconds = configService.getOrThrow<number>(
      'RISK_LOGIN_FAILURE_WINDOW_SECONDS',
    );
    this.loginFailureThreshold = configService.getOrThrow<number>(
      'RISK_LOGIN_FAILURE_THRESHOLD',
    );
    this.newSessionWindowSeconds = configService.getOrThrow<number>(
      'RISK_NEW_SESSION_WINDOW_SECONDS',
    );
    this.newSessionThreshold = configService.getOrThrow<number>(
      'RISK_NEW_SESSION_THRESHOLD',
    );
  }

  async assessNewSession(
    client: Prisma.TransactionClient,
    userId: string,
    snapshot: SecurityEventSnapshot,
    now: Date,
  ): Promise<RiskAssessment> {
    const signals: RiskAssessment['signals'] = [];
    const priorSessionCount = await client.securityEvent.count({
      where: { userId, type: 'SESSION_CREATED' },
    });

    if (priorSessionCount > 0) {
      if (
        snapshot.platform &&
        snapshot.platform !== 'UNKNOWN' &&
        (snapshot.deviceModelIdentifier || snapshot.deviceModel)
      ) {
        const knownDevice = await this.isKnownDevice(client, userId, snapshot);

        if (!knownDevice) {
          signals.push('NEW_DEVICE');
        }
      }

      if (snapshot.locationCountryCode) {
        const knownCountry = await client.securityEvent.findFirst({
          where: {
            userId,
            type: 'SESSION_CREATED',
            locationCountryCode: snapshot.locationCountryCode,
          },
          select: { id: true },
        });

        if (!knownCountry) {
          signals.push('NEW_COUNTRY');
        }
      }
    }

    const loginFailureWindowStart = new Date(
      now.getTime() - this.loginFailureWindowSeconds * 1000,
    );
    const recentLoginFailures = await client.securityEvent.count({
      where: {
        userId,
        type: 'LOGIN_FAILED',
        occurredAt: { gte: loginFailureWindowStart, lte: now },
      },
    });

    if (recentLoginFailures >= this.loginFailureThreshold) {
      signals.push('EXCESSIVE_LOGIN_FAILURES');
    }

    const newSessionWindowStart = new Date(
      now.getTime() - this.newSessionWindowSeconds * 1000,
    );
    const recentSessions = await client.securityEvent.count({
      where: {
        userId,
        type: 'SESSION_CREATED',
        occurredAt: { gte: newSessionWindowStart, lte: now },
      },
    });

    if (recentSessions >= Math.max(this.newSessionThreshold - 1, 0)) {
      signals.push('MANY_NEW_SESSIONS');
    }

    return {
      level: this.getLevel(signals),
      signals,
    };
  }

  refreshTokenReuse(): RiskAssessment {
    return {
      level: 'HIGH',
      signals: ['REFRESH_TOKEN_REUSE'],
    };
  }

  private async isKnownDevice(
    client: Prisma.TransactionClient,
    userId: string,
    snapshot: SecurityEventSnapshot,
  ): Promise<boolean> {
    if (snapshot.deviceModelIdentifier) {
      const identifierMatch = await client.securityEvent.findFirst({
        where: {
          userId,
          type: 'SESSION_CREATED',
          platform: snapshot.platform,
          deviceModelIdentifier: snapshot.deviceModelIdentifier,
        },
        select: { id: true },
      });

      if (identifierMatch) {
        return true;
      }

      if (!snapshot.deviceModel) {
        return false;
      }

      const identifierDisplayHistory = await client.securityEvent.findFirst({
        where: {
          userId,
          type: 'SESSION_CREATED',
          platform: snapshot.platform,
          deviceModelIdentifier: { not: null },
          deviceModel: snapshot.deviceModel,
        },
        select: { id: true },
      });

      if (identifierDisplayHistory) {
        return false;
      }

      const legacyDisplayMatch = await client.securityEvent.findFirst({
        where: {
          userId,
          type: 'SESSION_CREATED',
          platform: snapshot.platform,
          deviceModelIdentifier: null,
          deviceModel: snapshot.deviceModel,
        },
        select: { id: true },
      });

      return Boolean(legacyDisplayMatch);
    }

    const legacyDisplayMatch = await client.securityEvent.findFirst({
      where: {
        userId,
        type: 'SESSION_CREATED',
        platform: snapshot.platform,
        deviceModel: snapshot.deviceModel,
      },
      select: { id: true },
    });

    return Boolean(legacyDisplayMatch);
  }

  private getLevel(
    signals: RiskAssessment['signals'],
  ): RiskAssessment['level'] {
    if (signals.includes('REFRESH_TOKEN_REUSE')) {
      return 'HIGH';
    }

    const behavioralSignalCount = signals.filter((signal) =>
      ['EXCESSIVE_LOGIN_FAILURES', 'MANY_NEW_SESSIONS'].includes(signal),
    ).length;

    if (behavioralSignalCount >= 2) {
      return 'HIGH';
    }

    if (
      behavioralSignalCount === 1 ||
      (signals.includes('NEW_DEVICE') && signals.includes('NEW_COUNTRY'))
    ) {
      return 'MEDIUM';
    }

    return signals.length > 0 ? 'LOW' : null;
  }
}
