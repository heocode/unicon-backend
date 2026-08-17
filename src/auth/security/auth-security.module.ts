// NestJS
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

// Internal modules
import { PrismaModule } from '../../prisma/prisma.module';

// Internal guards
import { AccessTokenGuard } from '../guards/access-token.guard';

// Internal services
import { SessionAuthorizationService } from '../session/services/session-authorization.service';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  providers: [SessionAuthorizationService, AccessTokenGuard],
  exports: [JwtModule, SessionAuthorizationService, AccessTokenGuard],
})
export class AuthSecurityModule {}
