// NestJS
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal services
import { PrismaService } from '../../../prisma/prisma.service';

// Internal DTOs
import type { SessionsResponseDto } from '../../dtos/session-response.dto';

@Injectable()
export class SessionQueryService {
  private readonly managementCooldownSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.managementCooldownSeconds = configService.getOrThrow<number>(
      'SESSION_MANAGEMENT_COOLDOWN_SECONDS',
    );
  }

  async assertActive(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
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
        expiresAt: { gt: now },
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
      orderBy: { lastActiveAt: 'desc' },
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

  private getManagementAvailableAt(createdAt: Date): Date {
    return new Date(
      createdAt.getTime() + this.managementCooldownSeconds * 1000,
    );
  }
}
