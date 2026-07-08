import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
} from '@nestjs/swagger';

export function ApiRegister() {
  return applyDecorators(
    ApiOperation({
      summary: 'Register new account',
      description:
        'Creates a new user account using a university email address.',
    }),

    ApiCreatedResponse({
      description: 'User successfully registered.',
    }),

    ApiBadRequestResponse({
      description:
        'Passwords do not match, email domain is not allowed, or request data is invalid.',
    }),

    ApiConflictResponse({
      description: 'A user with this email already exists.',
    }),
  );
}
