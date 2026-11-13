import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService retention', () => {
  it('does not delete retained work with an active lease', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 2 });
    const service = new NotificationDeliveryService({
      notificationDelivery: { deleteMany },
    } as unknown as PrismaService);
    const now = new Date();
    expect(await service.deleteExpired(now)).toBe(2);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        retentionExpiresAt: { lte: now },
        OR: [
          { mailLeaseExpiresAt: null },
          { mailLeaseExpiresAt: { lte: now } },
        ],
      },
    });
  });
});
