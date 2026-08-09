// NestJS
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

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

    try {
      const token = extractBearerToken(request.headers.authorization);

      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(
        token,
        {
          secret: this.refreshSecret,
        },
      );

      validateBaseTokenPayload(payload);

      if (
        payload.tokenType !== 'refresh' ||
        typeof payload.jti !== 'string' ||
        payload.jti.length === 0
      ) {
        throw new UnauthorizedException();
      }

      request.user = payload;
      request.refreshToken = token;

      return true;
    } catch {
      throw new UnauthorizedException('The user is not authorized.');
    }
  }
}
