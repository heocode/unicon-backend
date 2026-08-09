import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { SessionLimitReachedErrorResponseDto } from '../../auth/dtos/session-error-response.dto';

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

    ApiConflictResponse({
      description: 'The active session limit has been reached.',
      type: SessionLimitReachedErrorResponseDto,
    }),
  );
}
