import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, TokenExpiredError } from '@nestjs/jwt';

import type { RefreshAuthenticatedRequest } from '../types/authenticated-request.type';
import { RefreshTokenGuard } from './refresh-token.guard';

describe('RefreshTokenGuard', () => {
  const jwtService = { verifyAsync: jest.fn() };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('refresh-test-secret'),
  };
  let request: Pick<
    RefreshAuthenticatedRequest,
    'headers' | 'user' | 'refreshToken'
  >;
  let context: ExecutionContext;
  let guard: RefreshTokenGuard;

  beforeEach(() => {
    jest.clearAllMocks();
    request = {
      headers: { authorization: 'Bearer refresh-token' },
      user: undefined as never,
      refreshToken: undefined as never,
    };
    context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    guard = new RefreshTokenGuard(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService,
    );
  });

  it('authorizes a valid refresh token and exposes it to the request', async () => {
    const payload = {
      sub: 'user-id',
      sessionId: 'session-id',
      tokenType: 'refresh' as const,
      jti: 'token-id',
    };
    jwtService.verifyAsync.mockResolvedValue(payload);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(payload);
    expect(request.refreshToken).toBe('refresh-token');
  });

  it('distinguishes missing, expired, and invalid refresh tokens', async () => {
    request.headers.authorization = undefined;
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'REFRESH_TOKEN_REQUIRED' },
    });

    request.headers.authorization = 'Bearer refresh-token';
    jwtService.verifyAsync.mockRejectedValueOnce(
      new TokenExpiredError('expired', new Date()),
    );
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'REFRESH_TOKEN_EXPIRED' },
    });

    jwtService.verifyAsync.mockRejectedValueOnce(new Error('invalid'));
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: 'REFRESH_TOKEN_INVALID' },
    });
  });
});
