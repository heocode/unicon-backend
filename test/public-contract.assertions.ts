const INTERNAL_FIELD_NAMES = new Set([
  'passwordHash',
  'refreshTokenHash',
  'resetTokenHash',
  'tokenHash',
  'verificationTokenHash',
  'deletionRequestedAt',
  'universityId',
  'userId',
  'revokedAt',
]);

export function expectOnlyKeys(
  value: unknown,
  expectedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
  expect(Object.keys(value as Record<string, unknown>).sort()).toEqual(
    [...expectedKeys].sort(),
  );
}

export function expectPublicError(
  value: unknown,
  expectedCode: string,
): asserts value is Record<string, unknown> {
  expectOnlyKeys(
    value,
    Object.prototype.hasOwnProperty.call(value, 'details')
      ? ['code', 'message', 'details']
      : ['code', 'message'],
  );
  expect(value.code).toBe(expectedCode);
  expect(value.message).toEqual(expect.any(String));
  expect(value.message).not.toHaveLength(0);
  expect(value).not.toHaveProperty('statusCode');
  expect(value).not.toHaveProperty('error');
}

export function expectNoInternalFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectNoInternalFields);
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [key, nestedValue] of Object.entries(value)) {
    expect(INTERNAL_FIELD_NAMES).not.toContain(key);
    expectNoInternalFields(nestedValue);
  }
}
