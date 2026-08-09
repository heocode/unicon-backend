// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { GeoIpModule } from '../geo-ip/geo-ip.module';
import { PrismaModule } from '../prisma/prisma.module';

// Internal services
import { SecurityEventService } from './services/security-event.service';

@Module({
  imports: [PrismaModule, GeoIpModule],
  providers: [SecurityEventService],
  exports: [SecurityEventService],
})
export class SecurityModule {}
