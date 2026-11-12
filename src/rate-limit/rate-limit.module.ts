import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { GcraAdmissionRepository } from './repositories/gcra-admission.repository';
import { GcraAdmissionConfigService } from './services/gcra-admission-config.service';
import { GcraAdmissionService } from './services/gcra-admission.service';
import { RateLimitBucketKeyService } from './services/rate-limit-bucket-key.service';

@Module({
  imports: [PrismaModule],
  providers: [
    RateLimitBucketKeyService,
    GcraAdmissionRepository,
    GcraAdmissionConfigService,
    GcraAdmissionService,
  ],
  exports: [
    GcraAdmissionRepository,
    RateLimitBucketKeyService,
    GcraAdmissionService,
    GcraAdmissionConfigService,
  ],
})
export class RateLimitModule {}
