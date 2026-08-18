import { BadRequestException } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import type { ValidationViolationCode } from '../types/public-error-code.type';

type ValidationViolation = {
  field: string;
  code: ValidationViolationCode;
  message: string;
};

const CONSTRAINT_MAPPINGS: ReadonlyArray<{
  constraints: readonly string[];
  code: ValidationViolationCode;
  message: string;
}> = [
  {
    constraints: ['whitelistValidation'],
    code: 'UNKNOWN_FIELD',
    message: 'This field is not allowed.',
  },
  {
    constraints: ['isDefined', 'isNotEmpty'],
    code: 'REQUIRED',
    message: 'This field is required.',
  },
  {
    constraints: ['isString'],
    code: 'INVALID_TYPE',
    message: 'This field has an invalid type.',
  },
  {
    constraints: ['isEmail'],
    code: 'INVALID_EMAIL',
    message: 'Email must be a valid email address.',
  },
  {
    constraints: ['isUuid'],
    code: 'INVALID_UUID',
    message: 'This field must be a valid UUID.',
  },
  {
    constraints: ['isStrongPassword'],
    code: 'WEAK_PASSWORD',
    message: 'Password does not meet the security requirements.',
  },
  {
    constraints: ['maxLength'],
    code: 'VALUE_TOO_LONG',
    message: 'This field exceeds the maximum length.',
  },
  {
    constraints: ['isLength', 'minLength'],
    code: 'INVALID_LENGTH',
    message: 'This field has an invalid length.',
  },
];

export function createValidationException(
  errors: ValidationError[],
): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: 'The request is invalid.',
    details: {
      violations: flattenValidationErrors(errors).sort(
        (left, right) =>
          left.field.localeCompare(right.field) ||
          left.code.localeCompare(right.code),
      ),
    },
  });
}

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): ValidationViolation[] {
  return errors.flatMap((error) => {
    const field = joinFieldPath(parentPath, error.property);
    const ownViolation = mapConstraints(field, error.constraints, error.value);
    const childViolations = flattenValidationErrors(
      error.children ?? [],
      field,
    );

    return ownViolation ? [ownViolation, ...childViolations] : childViolations;
  });
}

function mapConstraints(
  field: string,
  constraints?: Record<string, string>,
  value?: unknown,
): ValidationViolation | undefined {
  if (!constraints) {
    return undefined;
  }

  const constraintNames = new Set(Object.keys(constraints));
  if (
    (value === undefined || value === null) &&
    !constraintNames.has('whitelistValidation')
  ) {
    return {
      field,
      code: 'REQUIRED',
      message: 'This field is required.',
    };
  }

  const mapping = CONSTRAINT_MAPPINGS.find(({ constraints: candidates }) =>
    candidates.some((candidate) => constraintNames.has(candidate)),
  );

  if (!mapping) {
    return {
      field,
      code: 'INVALID_TYPE',
      message: 'This field is invalid.',
    };
  }

  return { field, code: mapping.code, message: mapping.message };
}

function joinFieldPath(parentPath: string, property: string): string {
  if (!parentPath) {
    return property;
  }

  return /^\d+$/.test(property)
    ? `${parentPath}[${property}]`
    : `${parentPath}.${property}`;
}
