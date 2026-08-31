import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';

import { RegistrationResponseDto } from '../../auth/dtos/auth-response.dto';
import { ValidationErrorDetailsDto } from '../../common/dtos/validation-error-response.dto';
import { ApiPublicErrorResponse } from '../common/public-error-response.decorator';

export function ApiRegister() {
  return applyDecorators(
    ApiOperation({
      summary: 'Register a new account',
      description:
        'Creates a pending account using an eligible institutional email.',
    }),
    ApiCreatedResponse({
      description: 'The pending account was created and verification sent.',
      type: RegistrationResponseDto,
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.BAD_REQUEST,
      codes: [
        'VALIDATION_FAILED',
        'MALFORMED_JSON',
        'EMAIL_DOMAIN_NOT_ALLOWED',
      ],
      description: 'The registration request is invalid or ineligible.',
      detailsTypes: [ValidationErrorDetailsDto],
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.CONFLICT,
      codes: ['EMAIL_ALREADY_REGISTERED'],
      description: 'An account with the email already exists.',
    }),
    ApiPublicErrorResponse({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      codes: ['REGISTRATION_UNAVAILABLE', 'VERIFICATION_EMAIL_UNAVAILABLE'],
      description: 'Registration cannot currently be completed.',
    }),
  );
}
