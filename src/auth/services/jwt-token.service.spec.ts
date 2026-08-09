import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtTokenService } from './jwt-token.service';
import type { RefreshTokenPayload } from '../types/jwt-payload.type';

describe('JwtTokenService', () => {
  const accessTtlSeconds = 900;
  const refreshExpiresAt = new Date('2027-08-08T12:00:00.000Z');

  let jwtService: JwtService;
  let service: JwtTokenService;

  beforeEach(() => {
    jwtService = new JwtService();
    service = new JwtTokenService(
      jwtService,
      new ConfigService({
        JWT_ACCESS_SECRET: 'access-test-secret',
        JWT_REFRESH_SECRET: 'refresh-test-secret',
        JWT_ACCESS_TTL_SECONDS: accessTtlSeconds,
      }),
    );
  });

  it('uses the session expiration as the exact refresh token exp', async () => {
    const tokens = await service.generateTokens(
      'user-id',
      'session-id',
      refreshExpiresAt,
    );

    const payload = jwtService.decode<RefreshTokenPayload>(tokens.refreshToken);

    expect(payload.exp).toBe(refreshExpiresAt.getTime() / 1000);
  });

  it('generates a unique refresh token jti on every rotation', async () => {
    const firstTokens = await service.generateTokens(
      'user-id',
      'session-id',
      refreshExpiresAt,
    );
    const secondTokens = await service.generateTokens(
      'user-id',
      'session-id',
      refreshExpiresAt,
    );

    const firstPayload = jwtService.decode<RefreshTokenPayload>(
      firstTokens.refreshToken,
    );
    const secondPayload = jwtService.decode<RefreshTokenPayload>(
      secondTokens.refreshToken,
    );

    expect(firstPayload.jti).not.toBe(secondPayload.jti);
    expect(firstTokens.refreshToken).not.toBe(secondTokens.refreshToken);
  });
});
