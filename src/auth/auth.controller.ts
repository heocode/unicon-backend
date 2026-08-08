// NestJS
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

// Internal decorators
import { ApiLogin } from '../swagger/auth/login.decorator';
import { ApiRegister } from '../swagger/auth/register.decorator';

// Internal services
import { AuthService } from './auth.service';

// Internal DTOs
import { LoginDto } from './dtos/login.dto';
import { RegisterDto } from './dtos/register.dto';
import { VerifyEmailDto } from './dtos/verify-email.dto';
import { ResendVerificationDto } from './dtos/resend-verification.dto';

// Internal guards
import { AccessTokenGuard } from './guards/access-token.guard';
import { RefreshTokenGuard } from './guards/refresh-token.guard';

// Internal types
import type {
  AccessAuthenticatedRequest,
  RefreshAuthenticatedRequest,
} from './types/authenticated-request.type';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiLogin()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiRegister()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(dto);
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
}
