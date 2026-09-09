const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertCanonicalUuid(value: string): void {
  if (!CANONICAL_UUID_PATTERN.test(value)) {
    throw new TypeError('UUID must use its canonical representation.');
  }
}
