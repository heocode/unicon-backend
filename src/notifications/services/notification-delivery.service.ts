import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';

// Retention only. Live mail enqueue/lease/transitions belong to MailModule.
@Injectable()
export class NotificationDeliveryService {
  constructor(private readonly prisma: PrismaService) {}
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.notificationDelivery.deleteMany({
      where: {
        retentionExpiresAt: { lte: now },
        OR: [
          { mailLeaseExpiresAt: null },
          { mailLeaseExpiresAt: { lte: now } },
        ],
      },
    });
    return result.count;
  }
}
