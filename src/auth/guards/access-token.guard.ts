// NestJS
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';

// Internal services
import { SessionAuthorizationService } from '../session/services/session-authorization.service';

// Internal types
import { AccessTokenPayload } from '../types/jwt-payload.type';
import { AccessAuthenticatedRequest } from '../types/authenticated-request.type';

// Internal utilities
import { extractBearerToken } from '../utils/extract-bearer-token.util';
import { validateBaseTokenPayload } from '../utils/validate-base-token-payload.util';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly accessSecret: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly sessionAuthorizationService: SessionAuthorizationService,
    configService: ConfigService,
  ) {
    this.accessSecret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AccessAuthenticatedRequest>();

    if (!request.headers.authorization) {
      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_REQUIRED',
        message: 'An access token is required.',
      });
    }

    let payload: AccessTokenPayload;

    try {
      const token = extractBearerToken(request.headers.authorization);

      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.accessSecret,
      });

      validateBaseTokenPayload(payload);

      if (payload.tokenType !== 'access') {
        throw new UnauthorizedException();
      }
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedException({
          code: 'ACCESS_TOKEN_EXPIRED',
          message: 'The access token has expired.',
        });
      }

      throw new UnauthorizedException({
        code: 'ACCESS_TOKEN_INVALID',
        message: 'The access token is invalid.',
      });
    }

    try {
      await this.sessionAuthorizationService.assertActive(
        payload.sub,
        payload.sessionId,
      );
    } catch {
      throw new UnauthorizedException({
        code: 'SESSION_UNAVAILABLE',
        message: 'The session is unavailable.',
      });
    }

    request.user = payload;

    return true;
  }
}
