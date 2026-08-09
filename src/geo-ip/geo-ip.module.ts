import { Module } from '@nestjs/common';
import { GeoIpService } from './geo-ip.service';
import { GeoIpDatabaseLoader } from './geo-ip-database.loader';

@Module({
  providers: [GeoIpService, GeoIpDatabaseLoader],
  exports: [GeoIpService],
})
export class GeoIpModule {}
