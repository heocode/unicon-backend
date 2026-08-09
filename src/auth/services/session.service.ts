// NestJS
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Node.js
import { randomUUID } from 'crypto';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';
import { JwtTokenService } from './jwt-token.service';
import { SecureTokenService } from './secure-token.service';
import { GeoIpService } from '../../geo-ip/geo-ip.service';

// Internal types
import type { SessionMetadata } from '../types/session-metadata.type';
import type { SessionsResponseDto } from '../dtos/session-response.dto';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class SessionService {
  private readonly inactivityTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly secureTokenService: SecureTokenService,
    private readonly geoIpService: GeoIpService,
    configService: ConfigService,
  ) {
    this.inactivityTtlSeconds = configService.getOrThrow<number>(
      'SESSION_INACTIVITY_TTL_SECONDS',
    );
  }

  async create(
    userId: string,
    metadata: SessionMetadata = { platform: 'UNKNOWN' },
  ): Promise<AuthTokens> {
    const sessionId = randomUUID();
    const expiresAt = this.getNextExpiration(new Date());
    const location = this.geoIpService.lookup(metadata.ipAddress);

    const generatedTokens = await this.jwtTokenService.generateTokens(
      userId,
      sessionId,
      expiresAt,
    );

    const hashedRefreshToken = this.secureTokenService.hash(
      generatedTokens.refreshToken,
    );

    await this.prisma.session.create({
      data: {
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
      },
    });

    return {
      accessToken: generatedTokens.accessToken,
      refreshToken: generatedTokens.refreshToken,
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
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
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

    return {
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
    sessionId: string,
    sessionName: string,
  ): Promise<{ id: string; sessionName: string }> {
    const result = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: {
        sessionName,
      },
    });

    if (result.count === 0) {
      throw new NotFoundException('Active session not found.');
    }

    return { id: sessionId, sessionName };
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
      },

      data: {
        revokedAt: new Date(),
      },
    });

    if (result.count === 0) {
      throw new UnauthorizedException('Access Denied. Session not found.');
    }
  }

  private getNextExpiration(now: Date): Date {
    const expiresAtSeconds =
      Math.floor(now.getTime() / 1000) + this.inactivityTtlSeconds;

    return new Date(expiresAtSeconds * 1000);
  }
}
