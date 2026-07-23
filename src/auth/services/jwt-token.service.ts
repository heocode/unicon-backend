import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
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
    username: string,
    sessionId: string,
  ): Promise<TokenPair> {
    const accessPayload = {
      sub: userId,
      username,
    };

    const refreshPayload = {
      sub: userId,
      username,
      sessionId,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.accessSecret,
        expiresIn: this.accessExpiresIn,
      }),
      this.jwtService.signAsync(refreshPayload, {
        secret: this.refreshSecret,
        expiresIn: this.refreshExpiresIn,
      }),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }
}
