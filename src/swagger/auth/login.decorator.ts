import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  AccountDeletionGracePeriodExpiredLoginErrorResponseDto,
  AccountDeletionScheduledLoginErrorResponseDto,
} from '../../auth/dtos/account-deletion-login-error-response.dto';
import { SessionLimitReachedErrorResponseDto } from '../../auth/dtos/session-error-response.dto';

export function ApiLogin() {
  return applyDecorators(
    ApiOperation({
      summary: 'Log into account',
      description: 'Authenticates a user using email and password.',
    }),

    ApiExtraModels(
      AccountDeletionScheduledLoginErrorResponseDto,
      AccountDeletionGracePeriodExpiredLoginErrorResponseDto,
    ),

    ApiCreatedResponse({
      description: 'User successfully authenticated.',
    }),

    ApiBadRequestResponse({
      description: 'Invalid request data.',
    }),

    ApiUnauthorizedResponse({
      description: 'Invalid email or password.',
    }),

    ApiForbiddenResponse({
      description:
        'The email is unverified, the account is unavailable, or account deletion is scheduled.',
      schema: {
        oneOf: [
          {
            $ref: getSchemaPath(AccountDeletionScheduledLoginErrorResponseDto),
          },
          {
            $ref: getSchemaPath(
              AccountDeletionGracePeriodExpiredLoginErrorResponseDto,
            ),
          },
        ],
      },
    }),

    ApiConflictResponse({
      description: 'The active session limit has been reached.',
      type: SessionLimitReachedErrorResponseDto,
    }),
  );
}
