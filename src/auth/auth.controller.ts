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
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiAcceptedResponse,
  ApiTooManyRequestsResponse,
  ApiConflictResponse,
} from '@nestjs/swagger';

// Internal decorators
import { ApiLogin } from '../swagger/auth/login.decorator';
import { ApiRegister } from '../swagger/auth/register.decorator';
import { SessionContext } from './decorators/session-context.decorator';

// Internal services
import { AuthService } from './auth.service';

// Internal DTOs
import { LoginDto } from './dtos/login.dto';
import { RegisterDto } from './dtos/register.dto';
import { VerifyEmailDto } from './dtos/verify-email.dto';
import { ResendVerificationDto } from './dtos/resend-verification.dto';
import { SessionsResponseDto } from './dtos/session-response.dto';
import {
  UpdateSessionDto,
  UpdateSessionResponseDto,
} from './dtos/update-session.dto';
import { SessionParamsDto } from './dtos/session-params.dto';
import { RevokeOtherSessionsResponseDto } from './dtos/revoke-other-sessions-response.dto';
import { ForgotPasswordDto } from './dtos/forgot-password.dto';
import { ResetPasswordDto } from './dtos/reset-password.dto';
import {
  ForgotPasswordResponseDto,
  PasswordResetTokenInvalidErrorResponseDto,
  RateLimitExceededErrorResponseDto,
  ResetPasswordResponseDto,
} from './dtos/password-recovery-response.dto';
import {
  SessionNotFoundErrorResponseDto,
  SessionTooFreshErrorResponseDto,
  UnauthorizedErrorResponseDto,
  ValidationErrorResponseDto,
} from './dtos/session-error-response.dto';

// Internal guards
import { AccessTokenGuard } from './guards/access-token.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';

// Internal types
import type {
  AccessAuthenticatedRequest,
  RefreshAuthenticatedRequest,
} from './types/authenticated-request.type';
import type { SessionMetadata } from './types/session-metadata.type';
import { RecoveryRateLimitFilter } from './recovery/filters/recovery-rate-limit.filter';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiLogin()
  @ApiHeader({
    name: 'X-Device-Model',
    required: false,
    description: 'Device model, for example iPhone 16 Pro.',
  })
  @ApiHeader({
    name: 'X-Platform',
    required: false,
    description: 'Client platform: IOS, ANDROID, or WEB.',
  })
  @ApiHeader({
    name: 'X-OS-Version',
    required: false,
    description: 'Operating system version.',
  })
  @ApiHeader({
    name: 'X-App-Version',
    required: false,
    description: 'Unicon application version.',
  })
  @Post('login')
  login(@Body() dto: LoginDto, @SessionContext() metadata: SessionMetadata) {
    return this.authService.login(dto, metadata);
  }

  @ApiRegister()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request password reset instructions' })
  @ApiAcceptedResponse({ type: ForgotPasswordResponseDto })
  @ApiBadRequestResponse({ type: ValidationErrorResponseDto })
  @ApiTooManyRequestsResponse({ type: RateLimitExceededErrorResponseDto })
  @UseFilters(RecoveryRateLimitFilter)
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @SessionContext() metadata: SessionMetadata,
  ) {
    return this.authService.forgotPassword(dto, metadata);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset a password using an emailed token' })
  @ApiOkResponse({ type: ResetPasswordResponseDto })
  @ApiBadRequestResponse({ type: PasswordResetTokenInvalidErrorResponseDto })
  @ApiConflictResponse({ description: 'The password changed concurrently.' })
  resetPassword(
    @Body() dto: ResetPasswordDto,
    @SessionContext() metadata: SessionMetadata,
  ) {
    return this.authService.resetPassword(dto, metadata);
  }

  @Post('verify-email')
  @ApiHeader({
    name: 'X-Device-Model',
    required: false,
    description: 'Device model, for example iPhone 16 Pro.',
  })
  @ApiHeader({
    name: 'X-Platform',
    required: false,
    description: 'Client platform: IOS, ANDROID, or WEB.',
  })
  @ApiHeader({
    name: 'X-OS-Version',
    required: false,
    description: 'Operating system version.',
  })
  @ApiHeader({
    name: 'X-App-Version',
    required: false,
    description: 'Unicon application version.',
  })
  verifyEmail(
    @Body() dto: VerifyEmailDto,
    @SessionContext() metadata: SessionMetadata,
  ) {
    return this.authService.verifyEmail(dto, metadata);
  }

  @Post('resend-verification')
  resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto);
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  refresh(@Req() request: RefreshAuthenticatedRequest) {
    return this.authService.refreshTokens(
      request.user.sub,
      request.user.sessionId,
      request.refreshToken,
    );
  }

  @Post('logout')
  @UseGuards(AccessTokenGuard)
  logout(@Req() request: AccessAuthenticatedRequest) {
    return this.authService.logout(request.user.sub, request.user.sessionId);
  }

  @Get('sessions')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List active sessions' })
  @ApiOkResponse({
    description: 'Active sessions belonging to the authenticated user.',
    type: SessionsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The user is not authorized.',
    type: UnauthorizedErrorResponseDto,
  })
  getSessions(@Req() request: AccessAuthenticatedRequest) {
    return this.authService.getSessions(
      request.user.sub,
      request.user.sessionId,
    );
  }

  @Patch('sessions/:sessionId')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set or clear a session name' })
  @ApiParam({
    name: 'sessionId',
    description: 'Session UUID.',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Session successfully renamed.',
    type: UpdateSessionResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid session ID or session name.',
    type: ValidationErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The user is not authorized.',
    type: UnauthorizedErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'The current session is too new to manage sessions.',
    type: SessionTooFreshErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Active session not found.',
    type: SessionNotFoundErrorResponseDto,
  })
  renameSession(
    @Req() request: AccessAuthenticatedRequest,
    @Param() params: SessionParamsDto,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.authService.renameSession(
      request.user.sub,
      request.user.sessionId,
      params.sessionId,
      dto,
    );
  }

  @Delete('sessions/others')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke all other active sessions' })
  @ApiOkResponse({
    description: 'All other active sessions successfully revoked.',
    type: RevokeOtherSessionsResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The user is not authorized.',
    type: UnauthorizedErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'The current session is too new to manage sessions.',
    type: SessionTooFreshErrorResponseDto,
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
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke an active session' })
  @ApiParam({
    name: 'sessionId',
    description: 'Session UUID.',
    format: 'uuid',
  })
  @ApiNoContentResponse({ description: 'Session successfully revoked.' })
  @ApiBadRequestResponse({
    description: 'Invalid session ID.',
    type: ValidationErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: 'The user is not authorized.',
    type: UnauthorizedErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'The current session is too new to manage sessions.',
    type: SessionTooFreshErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: 'Active session not found.',
    type: SessionNotFoundErrorResponseDto,
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
