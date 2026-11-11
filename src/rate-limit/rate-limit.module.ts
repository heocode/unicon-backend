import { Module } from '@nestjs/common';

import { RateLimitBucketKeyService } from './services/rate-limit-bucket-key.service';

@Module({
  providers: [RateLimitBucketKeyService],
  exports: [RateLimitBucketKeyService],
})
export class RateLimitModule {}
