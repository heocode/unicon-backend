import type { IsStrongPasswordOptions } from 'class-validator';

export const PASSWORD_VALIDATION_OPTIONS = {
  minLength: 8,
  minUppercase: 1,
  minNumbers: 1,
  minSymbols: 1,
} satisfies IsStrongPasswordOptions;

export const PASSWORD_VALIDATION_MESSAGE =
  'Password must be at least 8 characters long and contain at least one uppercase letter, one number, and one special character.';
