// NestJS
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';

// Internal guards
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { SessionContext } from '../auth/decorators/session-context.decorator';
import { ApiSessionMetadataHeaders } from '../swagger/auth/session-metadata.decorator';

// Internal services
import { PasswordChangeService } from './services/password-change.service';
import { AccountDeletionService } from './services/account-deletion.service';
import { AccountDeletionCancellationRateLimitFilter } from './filters/account-deletion-cancellation-rate-limit.filter';

// Internal DTOs
import {
  AccountUnavailableErrorResponseDto,
  AccountDeletionAlreadyCancelledErrorResponseDto,
  AccountDeletionGracePeriodExpiredErrorResponseDto,
  AccountStateChangedErrorResponseDto,
  CurrentPasswordInvalidErrorResponseDto,
  NewPasswordSameAsCurrentErrorResponseDto,
  PasswordChangedConcurrentlyErrorResponseDto,
  PasswordsDoNotMatchErrorResponseDto,
  SessionUnavailableErrorResponseDto,
  InvalidCredentialsErrorResponseDto,
} from './dtos/account-error-response.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { PasswordChangeResponseDto } from './dtos/password-change-response.dto';
import { AccountDeletionResponseDto } from './dtos/account-deletion-response.dto';
import { RequestAccountDeletionDto } from './dtos/request-account-deletion.dto';
import { CancelAccountDeletionDto } from './dtos/cancel-account-deletion.dto';
import { AccountDeletionCancelledResponseDto } from './dtos/account-deletion-cancelled-response.dto';
import { AccountDeletionRateLimitErrorResponseDto } from './dtos/account-deletion-rate-limit-error-response.dto';
import {
  SessionLimitReachedErrorResponseDto,
  UnauthorizedErrorResponseDto,
  ValidationErrorResponseDto,
} from '../auth/dtos/session-error-response.dto';

// Internal types
import type { AccessAuthenticatedRequest } from '../auth/types/authenticated-request.type';
import type { SessionMetadata } from '../auth/types/session-metadata.type';

@ApiTags('Account')
@ApiExtraModels(
  AccountUnavailableErrorResponseDto,
  AccountDeletionAlreadyCancelledErrorResponseDto,
  AccountDeletionGracePeriodExpiredErrorResponseDto,
  AccountStateChangedErrorResponseDto,
  CurrentPasswordInvalidErrorResponseDto,
  NewPasswordSameAsCurrentErrorResponseDto,
  PasswordChangedConcurrentlyErrorResponseDto,
  PasswordsDoNotMatchErrorResponseDto,
  SessionUnavailableErrorResponseDto,
  InvalidCredentialsErrorResponseDto,
  SessionLimitReachedErrorResponseDto,
  UnauthorizedErrorResponseDto,
  ValidationErrorResponseDto,
  AccountDeletionRateLimitErrorResponseDto,
)
@Controller('account')
export class AccountController {
  constructor(
    private readonly passwordChangeService: PasswordChangeService,
    private readonly accountDeletionService: AccountDeletionService,
  ) {}

  @Post('deletion/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiSessionMetadataHeaders()
  @UseFilters(AccountDeletionCancellationRateLimitFilter)
  @ApiOkResponse({
    description:
      'Deletion was cancelled and a completely new session was created.',
    type: AccountDeletionCancelledResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'The cancellation credentials are invalid.',
    type: ValidationErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The email or password is invalid.',
    type: InvalidCredentialsErrorResponseDto,
  })
  @ApiTooManyRequestsResponse({
    description: 'The email or IP cancellation-attempt limit was reached.',
    type: AccountDeletionRateLimitErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'The grace period expired, deletion was already cancelled, the account state changed, or a session cannot be created.',
    schema: {
      oneOf: [
        {
          $ref: getSchemaPath(AccountDeletionAlreadyCancelledErrorResponseDto),
        },
        {
          $ref: getSchemaPath(
            AccountDeletionGracePeriodExpiredErrorResponseDto,
          ),
        },
        { $ref: getSchemaPath(AccountStateChangedErrorResponseDto) },
        { $ref: getSchemaPath(SessionLimitReachedErrorResponseDto) },
      ],
    },
  })
  cancelDeletion(
    @Body() dto: CancelAccountDeletionDto,
    @SessionContext() metadata: SessionMetadata,
  ): Promise<AccountDeletionCancelledResponseDto> {
    return this.accountDeletionService.cancel(dto, metadata);
  }

  @Post('deletion')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Schedule deletion of the authenticated account' })
  @ApiAcceptedResponse({
    description:
      'Deletion was scheduled and every account session was revoked.',
    type: AccountDeletionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'The current-password input is invalid.',
    type: ValidationErrorResponseDto,
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
    description: 'The account state changed concurrently.',
    type: AccountStateChangedErrorResponseDto,
  })
  requestDeletion(
    @Req() request: AccessAuthenticatedRequest,
    @Body() dto: RequestAccountDeletionDto,
  ): Promise<AccountDeletionResponseDto> {
    return this.accountDeletionService.request(
      request.user.sub,
      request.user.sessionId,
      dto,
    );
  }

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
