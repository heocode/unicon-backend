import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ProfileModule } from './profile/profile.module';
import { AccountModule } from './account/account.module';
import { validateEnvironment } from './config/environment.validation';
import { HttpRateLimitModule } from './http-rate-limit/http-rate-limit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: '.env',
      isGlobal: true,
      validate: validateEnvironment,
    }),
    PrismaModule,
    HttpRateLimitModule,
    AuthModule,
    ProfileModule,
    AccountModule,
  ],
  providers: [],
  controllers: [],
})
export class AppModule {}
