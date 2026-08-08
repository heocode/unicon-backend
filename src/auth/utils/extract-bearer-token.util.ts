import { UnauthorizedException } from '@nestjs/common';

export function extractBearerToken(authorization?: string): string {
  if (!authorization) {
    throw new UnauthorizedException('The user is not authorized.');
  }

  const parts = authorization.split(' ');

  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
    throw new UnauthorizedException('The user is not authorized.');
  }

  return parts[1];
}
