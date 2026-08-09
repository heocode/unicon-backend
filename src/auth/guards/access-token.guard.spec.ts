import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { SessionService } from '../services/session.service';
import type { AccessAuthenticatedRequest } from '../types/authenticated-request.type';
import { AccessTokenGuard } from './access-token.guard';

describe('AccessTokenGuard', () => {
  const jwtService = {
    verifyAsync: jest.fn(),
  };
  const sessionService = {
    assertActive: jest.fn(),
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('access-test-secret'),
  };

  let request: Pick<AccessAuthenticatedRequest, 'headers' | 'user'>;
  let context: ExecutionContext;
  let guard: AccessTokenGuard;

  beforeEach(() => {
    jest.clearAllMocks();

    request = {
      headers: {
        authorization: 'Bearer access-token',
      },
      user: undefined as never,
    };
    context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    guard = new AccessTokenGuard(
      jwtService as unknown as JwtService,
      sessionService as unknown as SessionService,
      configService as unknown as ConfigService,
    );
  });

  it('authorizes an access token only when its session is active', async () => {
    const payload = {
      sub: 'user-id',
      sessionId: 'session-id',
      tokenType: 'access' as const,
    };
    jwtService.verifyAsync.mockResolvedValue(payload);
    sessionService.assertActive.mockResolvedValue(undefined);

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(sessionService.assertActive).toHaveBeenCalledWith(
      'user-id',
      'session-id',
    );
    expect(request.user).toBe(payload);
  });

  it('rejects a valid JWT when its session is unavailable', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-id',
      sessionId: 'session-id',
      tokenType: 'access',
    });
    sessionService.assertActive.mockRejectedValue(
      new UnauthorizedException('Session unavailable.'),
    );

    await expect(guard.canActivate(context)).rejects.toThrow(
      'The user is not authorized.',
    );
  });

  it('does not query a session for a refresh token', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      sub: 'user-id',
      sessionId: 'session-id',
      tokenType: 'refresh',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessionService.assertActive).not.toHaveBeenCalled();
  });
});
