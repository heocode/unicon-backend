import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

describe('NotificationDeliveryService retention', () => {
  // Active-lease semantics are exercised with actual PostgreSQL and held HTTP
  // responses in notification-mail-queue.e2e-spec.ts.
  it('returns the deleted count and binds the requested retention cutoff', async () => {
    const executeRaw = jest.fn().mockResolvedValue(2);
    const service = new NotificationDeliveryService({
      $executeRaw: executeRaw,
    } as unknown as PrismaService);
    const now = new Date();
    expect(await service.deleteExpired(now)).toBe(2);
    expect(executeRaw).toHaveBeenCalledWith(expect.any(Array), now);
  });
});
