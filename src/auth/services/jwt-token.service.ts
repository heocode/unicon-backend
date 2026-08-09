// NestJS
import { Injectable } from '@nestjs/common';

// Node.js
import { randomUUID } from 'crypto';

// Internal services
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// Internal types
import {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../types/jwt-payload.type';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
};

@Injectable()
export class JwtTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  private readonly accessTtlSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessSecret =
      this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');

    this.refreshSecret =
      this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');

    this.accessTtlSeconds = this.configService.getOrThrow<number>(
      'JWT_ACCESS_TTL_SECONDS',
    );
  }

  async generateTokens(
    userId: string,
    sessionId: string,
    refreshExpiresAt: Date,
  ): Promise<TokenPair> {
    const accessPayload: AccessTokenPayload = {
      sub: userId,
      sessionId,
      tokenType: 'access',
    };

    const refreshPayload: RefreshTokenPayload = {
      sub: userId,
      sessionId,
      tokenType: 'refresh',
      jti: randomUUID(),
      exp: Math.floor(refreshExpiresAt.getTime() / 1000),
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.accessTtlSeconds,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }
}
