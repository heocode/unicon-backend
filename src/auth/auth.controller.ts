// NestJS
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';

// Internal decorators
import { ApiLogin } from '../swagger/auth/login.decorator';
import { ApiRegister } from '../swagger/auth/register.decorator';
import { ApiSessionMetadataHeaders } from '../swagger/auth/session-metadata.decorator';
import { ApiPublicErrorResponse } from '../swagger/common/public-error-response.decorator';
import { SessionContext } from './decorators/session-context.decorator';

// Internal services
import { AuthService } from './auth.service';

// Internal DTOs
import {
  AuthTokensResponseDto,
  EmailVerificationResponseDto,
  RegistrationResponseDto,
  ResendVerificationResponseDto,
} from './dtos/auth-response.dto';
import { ForgotPasswordDto } from './dtos/forgot-password.dto';
import { LoginDto } from './dtos/login.dto';
import {
  ForgotPasswordResponseDto,
  ResetPasswordResponseDto,
} from './dtos/password-recovery-response.dto';
import { RegisterDto } from './dtos/register.dto';
import { ResendVerificationDto } from './dtos/resend-verification.dto';
import { ResetPasswordDto } from './dtos/reset-password.dto';
import { RevokeOtherSessionsResponseDto } from './dtos/revoke-other-sessions-response.dto';
import { SessionParamsDto } from './dtos/session-params.dto';
import { SessionsResponseDto } from './dtos/session-response.dto';
import {
  UpdateSessionDto,
  UpdateSessionResponseDto,
} from './dtos/update-session.dto';
import { VerifyEmailDto } from './dtos/verify-email.dto';
import {
  RateLimitErrorDetailsDto,
  SessionLimitErrorDetailsDto,
  SessionTooFreshErrorDetailsDto,
} from '../common/dtos/public-error-details.dto';
import { ValidationErrorDetailsDto } from '../common/dtos/validation-error-response.dto';

// Internal guards
import { AccessTokenGuard } from './guards/access-token.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';

// Internal filters
import { RecoveryRateLimitFilter } from './recovery/filters/recovery-rate-limit.filter';

// Internal types
import type {
  AccessAuthenticatedRequest,
  RefreshAuthenticatedRequest,
} from './types/authenticated-request.type';
import type { SessionMetadata } from './types/session-metadata.type';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiLogin()
  @ApiSessionMetadataHeaders()
  @Post('login')
  login(
    @Body() dto: LoginDto,
    @SessionContext() metadata: SessionMetadata,
  ): Promise<AuthTokensResponseDto> {
    return this.authService.login(dto, metadata);
  }

  @ApiRegister()
  @Post('register')
  register(@Body() dto: RegisterDto): Promise<RegistrationResponseDto> {
    return this.authService.register(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiSessionMetadataHeaders()
  @ApiOperation({ summary: 'Request password reset instructions' })
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
    description: 'The request body is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    codes: ['RATE_LIMIT_EXCEEDED'],
    description: 'The email or IP request limit was reached.',
    detailsTypes: [RateLimitErrorDetailsDto],
  })
  @UseFilters(RecoveryRateLimitFilter)
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @SessionContext() metadata: SessionMetadata,
  ): Promise<ForgotPasswordResponseDto> {
    return this.authService.forgotPassword(dto, metadata);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiSessionMetadataHeaders()
  @ApiOperation({ summary: 'Reset a password using an emailed token' })
  @ApiOkResponse({ type: ResetPasswordResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: [
      'VALIDATION_FAILED',
      'MALFORMED_JSON',
      'PASSWORDS_DO_NOT_MATCH',
      'PASSWORD_RESET_TOKEN_INVALID',
    ],
    description: 'The reset request or token is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: ['PASSWORD_CHANGED_CONCURRENTLY'],
    description: 'Another request changed the password first.',
  })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @SessionContext() metadata: SessionMetadata,
  ): Promise<ResetPasswordResponseDto> {
    return this.authService.resetPassword(dto, metadata);
  }

  @Post('verify-email')
  @ApiSessionMetadataHeaders()
  @ApiOperation({ summary: 'Verify an institutional email' })
  @ApiCreatedResponse({ type: EmailVerificationResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: [
      'VALIDATION_FAILED',
      'MALFORMED_JSON',
      'EMAIL_VERIFICATION_TOKEN_INVALID',
      'EMAIL_VERIFICATION_TOKEN_EXPIRED',
    ],
    description: 'The verification request or token is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['ACCOUNT_UNAVAILABLE'],
    description: 'The account became unavailable.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.CONFLICT,
    codes: ['EMAIL_ALREADY_VERIFIED', 'SESSION_LIMIT_REACHED'],
    description:
      'Verification or session creation conflicts with current state.',
    detailsTypes: [SessionLimitErrorDetailsDto],
  })
  verifyEmail(
    @Body() dto: VerifyEmailDto,
    @SessionContext() metadata: SessionMetadata,
  ): Promise<EmailVerificationResponseDto> {
    return this.authService.verifyEmail(dto, metadata);
  }

  @Post('resend-verification')
  @ApiOperation({ summary: 'Resend institutional-email verification' })
  @ApiCreatedResponse({ type: ResendVerificationResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
    description: 'The request body is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    codes: ['VERIFICATION_EMAIL_COOLDOWN'],
    description: 'Verification email resend is cooling down.',
    detailsTypes: [RateLimitErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    codes: ['VERIFICATION_EMAIL_UNAVAILABLE'],
    description: 'Verification email delivery is unavailable.',
  })
  resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<ResendVerificationResponseDto> {
    return this.authService.resendVerification(dto);
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  @ApiBearerAuth('refresh-token')
  @ApiOperation({ summary: 'Rotate a refresh token and issue a token pair' })
  @ApiCreatedResponse({ type: AuthTokensResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'REFRESH_TOKEN_REQUIRED',
      'REFRESH_TOKEN_INVALID',
      'REFRESH_TOKEN_EXPIRED',
      'REFRESH_TOKEN_REUSED',
    ],
    description: 'The refresh credential cannot be used.',
  })
  refresh(
    @Req() request: RefreshAuthenticatedRequest,
  ): Promise<AuthTokensResponseDto> {
    return this.authService.refreshTokens(
      request.user.sub,
      request.user.sessionId,
      request.refreshToken,
    );
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiNoContentResponse({ description: 'The current session was revoked.' })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or session is unavailable.',
  })
  async logout(@Req() request: AccessAuthenticatedRequest): Promise<void> {
    await this.authService.logout(request.user.sub, request.user.sessionId);
  }

  @Get('sessions')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'List active sessions' })
  @ApiOkResponse({ type: SessionsResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or session is unavailable.',
  })
  getSessions(
    @Req() request: AccessAuthenticatedRequest,
  ): Promise<SessionsResponseDto> {
    return this.authService.getSessions(
      request.user.sub,
      request.user.sessionId,
    );
  }

  @Patch('sessions/:sessionId')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Set or clear a session name' })
  @ApiParam({ name: 'sessionId', description: 'Session UUID.', format: 'uuid' })
  @ApiOkResponse({ type: UpdateSessionResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED', 'MALFORMED_JSON'],
    description: 'The session ID or request body is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or current session is unavailable.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['SESSION_TOO_FRESH'],
    description: 'The current session cannot yet manage sessions.',
    detailsTypes: [SessionTooFreshErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.NOT_FOUND,
    codes: ['SESSION_NOT_FOUND'],
    description: 'The target active session was not found.',
  })
  renameSession(
    @Req() request: AccessAuthenticatedRequest,
    @Param() params: SessionParamsDto,
    @Body() dto: UpdateSessionDto,
  ): Promise<UpdateSessionResponseDto> {
    return this.authService.renameSession(
      request.user.sub,
      request.user.sessionId,
      params.sessionId,
      dto,
    );
  }

  @Delete('sessions/others')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke all other active sessions' })
  @ApiOkResponse({ type: RevokeOtherSessionsResponseDto })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or current session is unavailable.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['SESSION_TOO_FRESH'],
    description: 'The current session cannot yet manage sessions.',
    detailsTypes: [SessionTooFreshErrorDetailsDto],
  })
  revokeOtherSessions(
    @Req() request: AccessAuthenticatedRequest,
  ): Promise<RevokeOtherSessionsResponseDto> {
    return this.authService.revokeOtherSessions(
      request.user.sub,
      request.user.sessionId,
    );
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke an active session' })
  @ApiParam({ name: 'sessionId', description: 'Session UUID.', format: 'uuid' })
  @ApiNoContentResponse({ description: 'The session was revoked.' })
  @ApiPublicErrorResponse({
    status: HttpStatus.BAD_REQUEST,
    codes: ['VALIDATION_FAILED'],
    description: 'The session ID is invalid.',
    detailsTypes: [ValidationErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.UNAUTHORIZED,
    codes: [
      'ACCESS_TOKEN_REQUIRED',
      'ACCESS_TOKEN_INVALID',
      'ACCESS_TOKEN_EXPIRED',
      'SESSION_UNAVAILABLE',
    ],
    description: 'The access credential or current session is unavailable.',
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.FORBIDDEN,
    codes: ['SESSION_TOO_FRESH'],
    description: 'The current session cannot yet manage sessions.',
    detailsTypes: [SessionTooFreshErrorDetailsDto],
  })
  @ApiPublicErrorResponse({
    status: HttpStatus.NOT_FOUND,
    codes: ['SESSION_NOT_FOUND'],
    description: 'The target active session was not found.',
  })
  async revokeSession(
    @Req() request: AccessAuthenticatedRequest,
    @Param() params: SessionParamsDto,
  ): Promise<void> {
    await this.authService.revokeSession(
      request.user.sub,
      request.user.sessionId,
      params.sessionId,
    );
  }
}
