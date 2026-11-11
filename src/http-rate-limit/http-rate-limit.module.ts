import { Module } from '@nestjs/common';

import { HttpRequestRateLimitConfigService } from './services/http-request-rate-limit-config.service';
import { RateLimitModule } from '../rate-limit/rate-limit.module';

@Module({
  imports: [RateLimitModule],
  providers: [HttpRequestRateLimitConfigService],
  exports: [HttpRequestRateLimitConfigService],
})
export class HttpRateLimitModule {}
