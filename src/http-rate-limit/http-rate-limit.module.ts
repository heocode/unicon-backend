import { Module } from '@nestjs/common';

import { HttpRequestRateLimitConfigService } from './services/http-request-rate-limit-config.service';

@Module({
  providers: [HttpRequestRateLimitConfigService],
  exports: [HttpRequestRateLimitConfigService],
})
export class HttpRateLimitModule {}
