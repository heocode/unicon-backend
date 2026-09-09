import { assertCanonicalUuid } from './assert-canonical-uuid.util';

describe('assertCanonicalUuid', () => {
  it('accepts a lowercase canonical UUID', () => {
    expect(() =>
      assertCanonicalUuid('123e4567-e89b-42d3-a456-426614174000'),
    ).not.toThrow();
  });

  it.each([
    '123E4567-E89B-42D3-A456-426614174000',
    '123e4567e89b42d3a456426614174000',
    ' 123e4567-e89b-42d3-a456-426614174000',
    'not-a-uuid',
  ])('rejects non-canonical UUID %s', (value) => {
    expect(() => assertCanonicalUuid(value)).toThrow(
      'UUID must use its canonical representation.',
    );
  });
});
