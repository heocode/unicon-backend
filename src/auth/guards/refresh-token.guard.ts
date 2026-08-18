// NestJS
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';

// Internal types
import { RefreshTokenPayload } from '../types/jwt-payload.type';
import { RefreshAuthenticatedRequest } from '../types/authenticated-request.type';

// Internal utilities
import { extractBearerToken } from '../utils/extract-bearer-token.util';
import { validateBaseTokenPayload } from '../utils/validate-base-token-payload.util';

@Injectable()
export class RefreshTokenGuard implements CanActivate {
  private readonly refreshSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    this.refreshSecret = configService.getOrThrow<string>('JWT_REFRESH_SECRET');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<RefreshAuthenticatedRequest>();

    if (!request.headers.authorization) {
      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_REQUIRED',
        message: 'A refresh token is required.',
      });
    }

    let token: string;
    let payload: RefreshTokenPayload;

    try {
      token = extractBearerToken(request.headers.authorization);

      payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
      });

      validateBaseTokenPayload(payload);

      if (
        payload.tokenType !== 'refresh' ||
        typeof payload.jti !== 'string' ||
        payload.jti.length === 0
      ) {
        throw new UnauthorizedException();
      }
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedException({
          code: 'REFRESH_TOKEN_EXPIRED',
          message: 'The refresh token has expired.',
        });
      }

      throw new UnauthorizedException({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'The refresh token is invalid.',
      });
    }

    request.user = payload;
    request.refreshToken = token;

    return true;
  }
}
