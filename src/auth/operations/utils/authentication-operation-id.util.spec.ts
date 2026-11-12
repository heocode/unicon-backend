import {
  createAuthenticationOperationId,
  authenticationOperationWindow,
  assertAuthenticationOperationActive,
} from './authentication-operation-id.util';

describe('Authentication operation UUIDv7 protocol', () => {
  const now = 1_800_000_000_123_456n;
  it('encodes DB milliseconds and preserves version/variant with random independent IDs', () => {
    const ids = Array.from({ length: 32 }, () =>
      createAuthenticationOperationId(now),
    );
    expect(new Set(ids).size).toBe(32);
    for (const id of ids) {
      expect(id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      );
      expect(authenticationOperationWindow(id)).toEqual({
        issuedAtMicros: (now / 1000n) * 1000n,
        expiresAtMicros: (now / 1000n) * 1000n + 86_400_000_000n,
        retentionExpiresAtMicros: (now / 1000n) * 1000n + 86_700_000_000n,
      });
    }
  });
  it('rejects expiry exactly at 24 hours without consulting receipt existence', () => {
    const id = createAuthenticationOperationId(now);
    const window = authenticationOperationWindow(id);
    expect(() =>
      assertAuthenticationOperationActive(id, window.expiresAtMicros - 1n),
    ).not.toThrow();
    const failure = (at: bigint) => {
      try {
        assertAuthenticationOperationActive(id, at);
        return null;
      } catch (error: unknown) {
        return error;
      }
    };
    expect(failure(window.expiresAtMicros)).toMatchObject({
      reason: 'OPERATION_EXPIRED',
    });
    expect(failure(window.issuedAtMicros - 1n)).toMatchObject({
      reason: 'INVALID_INPUT',
    });
  });
  it.each([
    'not-an-id',
    '123e4567-e89b-42d3-a456-426614174000',
    '019F22E2-79B0-7CC3-98C4-DC0C0C07398F',
  ])('rejects noncanonical or non-v7 operation IDs (%s)', (id) =>
    expect(() => authenticationOperationWindow(id)).toThrow(),
  );
});
