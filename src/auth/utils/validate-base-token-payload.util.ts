import { UnauthorizedException } from '@nestjs/common';

type BaseTokenPayload = {
  sub: string;
  sessionId: string;
};

export function validateBaseTokenPayload(
  payload: unknown,
): asserts payload is BaseTokenPayload {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('sub' in payload) ||
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    !('sessionId' in payload) ||
    typeof payload.sessionId !== 'string' ||
    payload.sessionId.length === 0
  ) {
    throw new UnauthorizedException('The user is not authorized.');
  }
}
