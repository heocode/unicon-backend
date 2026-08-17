// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { AuthSecurityModule } from '../auth/security/auth-security.module';
import { PrismaModule } from '../prisma/prisma.module';

// Controllers
import { ProfileController } from './profile.controller';

// Services
import { ProfileQueryService } from './services/profile-query.service';

@Module({
  imports: [AuthSecurityModule, PrismaModule],
  controllers: [ProfileController],
  providers: [ProfileQueryService],
})
export class ProfileModule {}
