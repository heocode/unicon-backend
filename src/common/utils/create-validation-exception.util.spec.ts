import type { ValidationError } from 'class-validator';

import { createValidationException } from './create-validation-exception.util';

describe('createValidationException', () => {
  it('maps and deterministically orders public violations', () => {
    const exception = createValidationException([
      {
        property: 'password',
        value: 'weak',
        constraints: { isStrongPassword: 'internal class-validator message' },
      },
      {
        property: 'email',
        value: 42,
        constraints: {
          isEmail: 'internal class-validator message',
          isString: 'internal class-validator message',
        },
      },
    ] as ValidationError[]);

    expect(exception.getResponse()).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request is invalid.',
      details: {
        violations: [
          {
            field: 'email',
            code: 'INVALID_TYPE',
            message: 'This field has an invalid type.',
          },
          {
            field: 'password',
            code: 'WEAK_PASSWORD',
            message: 'Password does not meet the security requirements.',
          },
        ],
      },
    });
  });

  it('uses nested array paths and maps forbidden properties', () => {
    const exception = createValidationException([
      {
        property: 'items',
        children: [
          {
            property: '0',
            children: [
              {
                property: 'role',
                constraints: { whitelistValidation: 'not allowed' },
              },
            ],
          },
        ],
      },
    ] as ValidationError[]);

    expect(exception.getResponse()).toMatchObject({
      details: {
        violations: [
          {
            field: 'items[0].role',
            code: 'UNKNOWN_FIELD',
          },
        ],
      },
    });
  });
});
