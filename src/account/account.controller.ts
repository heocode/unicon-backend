// NestJS
import { Body, Controller, Patch, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

// Internal guards
import { AccessTokenGuard } from '../auth/guards/access-token.guard';

// Internal services
import { PasswordChangeService } from './services/password-change.service';

// Internal DTOs
import {
  AccountUnavailableErrorResponseDto,
  CurrentPasswordInvalidErrorResponseDto,
  NewPasswordSameAsCurrentErrorResponseDto,
  PasswordChangedConcurrentlyErrorResponseDto,
  PasswordsDoNotMatchErrorResponseDto,
  SessionUnavailableErrorResponseDto,
} from './dtos/account-error-response.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { PasswordChangeResponseDto } from './dtos/password-change-response.dto';
import { UnauthorizedErrorResponseDto } from '../auth/dtos/session-error-response.dto';

// Internal types
import type { AccessAuthenticatedRequest } from '../auth/types/authenticated-request.type';

@ApiTags('Account')
@ApiExtraModels(
  AccountUnavailableErrorResponseDto,
  CurrentPasswordInvalidErrorResponseDto,
  NewPasswordSameAsCurrentErrorResponseDto,
  PasswordChangedConcurrentlyErrorResponseDto,
  PasswordsDoNotMatchErrorResponseDto,
  SessionUnavailableErrorResponseDto,
  UnauthorizedErrorResponseDto,
)
@Controller('account')
export class AccountController {
  constructor(private readonly passwordChangeService: PasswordChangeService) {}

  @Patch('password')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Change the authenticated user password' })
  @ApiOkResponse({
    description: 'The password was changed and other sessions were revoked.',
    type: PasswordChangeResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'The password input is invalid.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(PasswordsDoNotMatchErrorResponseDto) },
        { $ref: getSchemaPath(NewPasswordSameAsCurrentErrorResponseDto) },
      ],
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Authorization or current-password verification failed.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(UnauthorizedErrorResponseDto) },
        { $ref: getSchemaPath(AccountUnavailableErrorResponseDto) },
        { $ref: getSchemaPath(CurrentPasswordInvalidErrorResponseDto) },
        { $ref: getSchemaPath(SessionUnavailableErrorResponseDto) },
      ],
    },
  })
  @ApiConflictResponse({
    description: 'Another request changed the password concurrently.',
    type: PasswordChangedConcurrentlyErrorResponseDto,
  })
  changePassword(
    @Req() request: AccessAuthenticatedRequest,
    @Body() dto: ChangePasswordDto,
  ): Promise<PasswordChangeResponseDto> {
    return this.passwordChangeService.change(
      request.user.sub,
      request.user.sessionId,
      dto,
    );
  }
}
