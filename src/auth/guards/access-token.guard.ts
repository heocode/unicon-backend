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
    configService: ConfigService,
  ) {
    this.accessSecret = configService.getOrThrow<string>('JWT_ACCESS_SECRET');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AccessAuthenticatedRequest>();

    try {
      const token = extractBearerToken(request.headers.authorization);

      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        {
          secret: this.accessSecret,
        },
      );

      validateBaseTokenPayload(payload);

      if (payload.tokenType !== 'access') {
        throw new UnauthorizedException();
      }

      request.user = payload;

      return true;
    } catch {
      throw new UnauthorizedException('The user is not authorized.');
    }
  }
}
