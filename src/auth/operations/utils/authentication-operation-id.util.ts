import { randomBytes } from 'node:crypto';

import {
  AUTHENTICATION_OPERATION_RETRY_SECONDS,
  AUTHENTICATION_OPERATION_RETENTION_GRACE_SECONDS,
} from '../constants/authentication-operation.constants';
import { AuthenticationOperationError } from '../errors/authentication-operation.error';

/** RFC 9562 UUIDv7: DB epoch milliseconds plus 74 random bits; no host identifier. */
export function createAuthenticationOperationId(nowMicros: bigint): string {
  const millis = nowMicros / 1000n;
  if (nowMicros < 0n || millis > 0xffffffffffffn)
    throw new AuthenticationOperationError('INVALID_INPUT');
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Number(millis), 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function authenticationOperationWindow(id: string) {
  if (
    typeof id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    )
  ) {
    throw new AuthenticationOperationError('INVALID_INPUT');
  }
  const issuedAtMicros =
    BigInt(`0x${id.slice(0, 8)}${id.slice(9, 13)}`) * 1000n;
  return Object.freeze({
    issuedAtMicros,
    expiresAtMicros:
      issuedAtMicros +
      BigInt(AUTHENTICATION_OPERATION_RETRY_SECONDS) * 1_000_000n,
    retentionExpiresAtMicros:
      issuedAtMicros +
      BigInt(
        AUTHENTICATION_OPERATION_RETRY_SECONDS +
          AUTHENTICATION_OPERATION_RETENTION_GRACE_SECONDS,
      ) *
        1_000_000n,
  });
}

export function assertAuthenticationOperationActive(
  id: string,
  nowMicros: bigint,
): void {
  const window = authenticationOperationWindow(id);
  if (nowMicros < window.issuedAtMicros)
    throw new AuthenticationOperationError('INVALID_INPUT');
  if (nowMicros >= window.expiresAtMicros)
    throw new AuthenticationOperationError('OPERATION_EXPIRED');
}
