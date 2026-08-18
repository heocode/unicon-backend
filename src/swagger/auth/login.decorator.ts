import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';

import { AuthTokensResponseDto } from '../../auth/dtos/auth-response.dto';
import {
  AccountDeletionLoginErrorDetailsDto,
  EmailNotVerifiedErrorDetailsDto,
  SessionLimitErrorDetailsDto,
} from '../../common/dtos/public-error-details.dto';
import { ValidationErrorDetailsDto } from '../../common/dtos/validation-error-response.dto';
import { ApiPublicErrorResponse } from '../common/public-error-response.decorator';

export function ApiLogin() {
  return applyDecorators(
    ApiOperation({
      summary: 'Log into an account',
      description: 'Authenticates using the current MVP email and password.',
    }),
    ApiCreatedResponse({
      description: 'A new independent session was created.',
      type: AuthTokensResponseDto,
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.BAD_REQUEST,
      codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
      description: 'The request body is invalid.',
      detailsTypes: [ValidationErrorDetailsDto],
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.UNAUTHORIZED,
      codes: ['INVALID_CREDENTIALS'],
      description: 'The credentials are invalid.',
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.FORBIDDEN,
      codes: [
        'EMAIL_NOT_VERIFIED',
        'ACCOUNT_UNAVAILABLE',
        'ACCOUNT_DELETION_SCHEDULED',
        'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
      ],
      description: 'The account cannot currently create a session.',
      detailsTypes: [
        EmailNotVerifiedErrorDetailsDto,
        AccountDeletionLoginErrorDetailsDto,
      ],
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.CONFLICT,
      codes: ['SESSION_LIMIT_REACHED'],
      description: 'The active-session limit was reached.',
      detailsTypes: [SessionLimitErrorDetailsDto],
    }),
  );
}
