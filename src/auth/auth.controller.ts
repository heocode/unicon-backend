import { Controller, Post, Body, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiRegister } from '../swagger/auth/register.decorator';
import { ApiLogin } from '../swagger/auth/login.decorator';
import { AccessTokenGuard } from './guard/access-token.guard';
import { RefreshTokenGuard } from './guard/refresh-token.guard';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiLogin()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiRegister()
  @Post('register')
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  refresh(@Req() req) {
    return this.authService.refreshTokens(
      req.user.sub,
      req.user.sessionId,
      req.refreshToken,
    );
  }

  @Post('logout')
  @UseGuards(AccessTokenGuard)
  logout(@Req() req) {
    return this.authService.logout(req.user.sub, req.user.sessionId);
  }
}
