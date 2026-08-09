// NestJS
import { Module } from '@nestjs/common';

// Internal modules
import { GeoIpModule } from '../geo-ip/geo-ip.module';
import { PrismaModule } from '../prisma/prisma.module';

// Internal services
import { SecurityEventService } from './services/security-event.service';
import { RiskAnalysisService } from './services/risk-analysis.service';

@Module({
  imports: [PrismaModule, GeoIpModule],
  providers: [SecurityEventService, RiskAnalysisService],
  exports: [SecurityEventService, RiskAnalysisService],
})
export class SecurityModule {}
