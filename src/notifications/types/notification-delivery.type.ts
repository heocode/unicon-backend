import type { NotificationType, Prisma } from '../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

export type NotificationDeliveryClient =
  PrismaService | Prisma.TransactionClient;

export type CreateNotificationDelivery = {
  idempotencyKey: string;
  type: NotificationType;
  userId?: string;
  sessionId?: string | null;
  recipient: string;
  createdAt?: Date;
};

export type ClaimRetryableNotificationDelivery = {
  deliveryId: string;
  type: NotificationType;
  attemptedAt: Date;
  retryBefore: Date;
};

export type FindRetryableNotificationDeliveries = {
  type: NotificationType;
  retryBefore: Date;
  limit: number;
};
