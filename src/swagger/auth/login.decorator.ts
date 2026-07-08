import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

export function ApiLogin() {
  return applyDecorators(
    ApiOperation({
      summary: 'Log into account',
      description: 'Authenticates a user using email and password.',
    }),

    ApiOkResponse({
      description: 'User successfully authenticated.',
    }),

    ApiBadRequestResponse({
      description: 'Invalid request data.',
    }),

    ApiUnauthorizedResponse({
      description: 'Invalid email or password.',
    }),
  );
}
