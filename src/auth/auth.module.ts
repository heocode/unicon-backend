// NestJS
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

// Internal modules
import { PrismaModule } from '../prisma/prisma.module';

// Controllers
import { AuthController } from './auth.controller';

// Services
import { AuthService } from './auth.service';
import { JwtTokenService } from './services/jwt-token.service';
import { PasswordService } from './services/password.service';

// Guards
import { AccessTokenGuard } from './guard/access-token.guard';
import { RefreshTokenGuard } from './guard/refresh-token.guard';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';

@Module({
  imports: [PrismaModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    JwtTokenService,
    SecureTokenService,
    UsernameService,
    AccessTokenGuard,
    RefreshTokenGuard,
  ],
  exports: [AuthService],
})
export class AuthModule {}
