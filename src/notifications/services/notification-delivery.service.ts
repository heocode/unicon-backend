import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// Retention only. Live mail enqueue/lease/transitions belong to MailModule.
@Injectable()
export class NotificationDeliveryService {
  constructor(private readonly prisma: PrismaService) {}
  async deleteExpired(now: Date = new Date()): Promise<number> {
    // The caller selects a retention cutoff, not a clock that can revoke leases.
    // PostgreSQL remains authoritative even with a future cutoff or host skew.
    return this.prisma.$executeRaw`
      DELETE FROM "NotificationDelivery"
      WHERE "retentionExpiresAt" <= ${now}
        AND ("mailLeaseExpiresAt" IS NULL OR "mailLeaseExpiresAt" <= clock_timestamp())
    `;
  }
}
