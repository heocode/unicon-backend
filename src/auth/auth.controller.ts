// NestJS
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnauthorizedResponse,
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

// Internal guards
import { AccessTokenGuard } from './guards/access-token.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';

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
  @ApiOkResponse({
    description: 'Active sessions belonging to the authenticated user.',
    type: SessionsResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'The user is not authorized.' })
  getSessions(@Req() request: AccessAuthenticatedRequest) {
    return this.authService.getSessions(
      request.user.sub,
      request.user.sessionId,
    );
  }

  @Patch('sessions/:sessionId')
  @UseGuards(AccessTokenGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Session successfully renamed.',
    type: UpdateSessionResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid session name.' })
  @ApiUnauthorizedResponse({ description: 'The user is not authorized.' })
  @ApiNotFoundResponse({ description: 'Active session not found.' })
  renameSession(
    @Req() request: AccessAuthenticatedRequest,
    @Param('sessionId') sessionId: string,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.authService.renameSession(request.user.sub, sessionId, dto);
  }
}
