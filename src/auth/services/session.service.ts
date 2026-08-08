// NestJS
import { Injectable, UnauthorizedException } from '@nestjs/common';

// Node.js
import { randomUUID } from 'crypto';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';
import { JwtTokenService } from './jwt-token.service';
import { SecureTokenService } from './secure-token.service';

type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtTokenService: JwtTokenService,
    private readonly secureTokenService: SecureTokenService,
  ) {}

  async create(userId: string): Promise<AuthTokens> {
    const sessionId = randomUUID();

    const generatedTokens = await this.jwtTokenService.generateTokens(
      userId,
      sessionId,
    );

    const hashedRefreshToken = this.secureTokenService.hash(
      generatedTokens.refreshToken,
    );

    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
        hashedRefreshToken,
        expiresAt: generatedTokens.refreshTokenExpiresAt,
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

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Access Denied. Session expired.');
    }

    if (session.user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Access Denied. Account is not active.');
    }

    const incomingTokenHash = this.secureTokenService.hash(refreshToken);

    if (incomingTokenHash !== session.hashedRefreshToken) {
      await this.prisma.session.update({
        where: { id: session.id },

        data: { revokedAt: new Date() },
      });

      throw new UnauthorizedException('Access Denied. Invalid token.');
    }

    const generatedTokens = await this.jwtTokenService.generateTokens(
      userId,
      session.id,
      session.expiresAt,
    );

    await this.updateRefreshTokenHash(session.id, generatedTokens.refreshToken);

    return {
      accessToken: generatedTokens.accessToken,
      refreshToken: generatedTokens.refreshToken,
    };
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

  private async updateRefreshTokenHash(
    sessionId: string,
    refreshToken: string,
  ): Promise<void> {
    const hashedRefreshToken = this.secureTokenService.hash(refreshToken);

    await this.prisma.session.update({
      where: {
        id: sessionId,
      },
      data: {
        hashedRefreshToken,
      },
    });
  }
}
