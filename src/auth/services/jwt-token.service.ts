// NestJS
import { Injectable } from '@nestjs/common';

// Internal services
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

// Internal types
import {
  AccessTokenPayload,
  RefreshTokenPayload,
} from '../types/jwt-payload.type';

// External
import type { StringValue } from 'ms';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

@Injectable()
export class JwtTokenService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;

  private readonly accessExpiresIn: StringValue;
  private readonly refreshExpiresIn: StringValue;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.accessSecret =
      this.configService.getOrThrow<string>('JWT_ACCESS_SECRET');

    this.refreshSecret =
      this.configService.getOrThrow<string>('JWT_REFRESH_SECRET');

    this.accessExpiresIn = this.configService.getOrThrow<StringValue>(
      'JWT_ACCESS_EXPIRES_IN',
    );

    this.refreshExpiresIn = this.configService.getOrThrow<StringValue>(
      'JWT_REFRESH_EXPIRES_IN',
    );
  }

  async generateTokens(
    userId: string,
    sessionId: string,
    refreshExpiresAt?: Date,
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
    };

    if (refreshExpiresAt) {
      refreshPayload.exp = Math.floor(refreshExpiresAt.getTime() / 1000);
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.accessExpiresIn,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        ...(refreshExpiresAt ? {} : { expiresIn: this.refreshExpiresIn }),
      }),
    ]);

    const resolvedRefreshExpiresAt =
      refreshExpiresAt ?? this.getTokenExpiration(refreshToken);

    return {
      accessToken,
      refreshToken,
      refreshTokenExpiresAt: resolvedRefreshExpiresAt,
    };
  }

  private getTokenExpiration(token: string): Date {
    const payload: unknown = this.jwtService.decode(token);

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number'
    ) {
      throw new Error(
        'Generated refresh token does not contain a valid expiration.',
      );
    }

    return new Date(payload.exp * 1000);
  }
}
