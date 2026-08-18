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
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';

// Internal guards and decorators
import { SessionContext } from '../auth/decorators/session-context.decorator';
import { AccessTokenGuard } from '../auth/guards/access-token.guard';
import { ApiSessionMetadataHeaders } from '../swagger/auth/session-metadata.decorator';
import { ApiPublicErrorResponse } from '../swagger/common/public-error-response.decorator';

// Internal services
import { AccountDeletionService } from './services/account-deletion.service';
import { PasswordChangeService } from './services/password-change.service';

// Internal DTOs
import { AccountDeletionCancelledResponseDto } from './dtos/account-deletion-cancelled-response.dto';
import { AccountDeletionResponseDto } from './dtos/account-deletion-response.dto';
import { CancelAccountDeletionDto } from './dtos/cancel-account-deletion.dto';
import { ChangePasswordDto } from './dtos/change-password.dto';
import { PasswordChangeResponseDto } from './dtos/password-change-response.dto';
import { RequestAccountDeletionDto } from './dtos/request-account-deletion.dto';
import {
  RateLimitErrorDetailsDto,
  SessionLimitErrorDetailsDto,
} from '../common/dtos/public-error-details.dto';
import { ValidationErrorDetailsDto } from '../common/dtos/validation-error-response.dto';

// Internal filters
import { AccountDeletionCancellationRateLimitFilter } from './filters/account-deletion-cancellation-rate-limit.filter';

// Internal types
import type { AccessAuthenticatedRequest } from '../auth/types/authenticated-request.type';
import type { SessionMetadata } from '../auth/types/session-metadata.type';

@ApiTags('Account')
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
  @ApiOperation({ summary: 'Cancel scheduled account deletion' })
  @ApiOkResponse({ type: AccountDeletionCancelledResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
    description: 'The cancellation request is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: ['INVALID_CREDENTIALS'],
    description: 'The email or password is invalid.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    codes: ['RATE_LIMIT_EXCEEDED'],
    description: 'The email or IP cancellation-attempt limit was reached.',
    detailsTypes: [RateLimitErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: [
      'ACCOUNT_DELETION_ALREADY_CANCELLED',
      'ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED',
      'ACCOUNT_STATE_CHANGED',
      'SESSION_LIMIT_REACHED',
    ],
    description: 'The account state cannot be cancelled as requested.',
    detailsTypes: [SessionLimitErrorDetailsDto],
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
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Schedule deletion of the authenticated account' })
  @ApiAcceptedResponse({ type: AccountDeletionResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
    description: 'The deletion request is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
      'CURRENT_PASSWORD_INVALID',
    ],
    description: 'Authorization or current-password verification failed.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['ACCOUNT_UNAVAILABLE'],
    description: 'The account cannot schedule deletion.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: ['ACCOUNT_STATE_CHANGED'],
    description: 'The account state changed concurrently.',
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
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Change the authenticated user password' })
  @ApiOkResponse({ type: PasswordChangeResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: [
      'VALIDATION_FAILED',
      'MALFORMED_JSON',
      'PASSWORDS_DO_NOT_MATCH',
      'NEW_PASSWORD_SAME_AS_CURRENT',
    ],
    description: 'The password request is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
      'CURRENT_PASSWORD_INVALID',
    ],
    description: 'Authorization or current-password verification failed.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['ACCOUNT_UNAVAILABLE'],
    description: 'The account cannot change its password.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: ['PASSWORD_CHANGED_CONCURRENTLY'],
    description: 'Another request changed the password first.',
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
