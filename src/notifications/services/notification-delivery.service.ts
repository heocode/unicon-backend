import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ClaimRetryableNotificationDelivery,
  CreateNotificationDelivery,
  FindRetryableNotificationDeliveries,
  NotificationDeliveryClient,
} from '../types/notification-delivery.type';

@Injectable()
export class NotificationDeliveryService {
  private readonly retentionSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.retentionSeconds = configService.getOrThrow<number>(
      'NOTIFICATION_DELIVERY_RETENTION_SECONDS',
    );
  }

  async createIdempotent(
    input: CreateNotificationDelivery,
    client: NotificationDeliveryClient = this.prisma,
  ): Promise<{ id: string } | null> {
    const createdAt = input.createdAt ?? new Date();

    try {
      return await client.notificationDelivery.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          type: input.type,
          channel: 'EMAIL',
          userId: input.userId,
          sessionId: input.sessionId,
          recipient: input.recipient,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
          retentionExpiresAt: new Date(
            createdAt.getTime() + this.retentionSeconds * 1000,
          ),
        },
        select: { id: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null;
      }
      throw error;
    }
  }

  async markSent(input: {
    deliveryId: string;
    providerMessageId: string;
    attemptedAt: Date;
    sentAt?: Date;
  }): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: input.deliveryId },
      data: {
        status: 'SENT',
        providerMessageId: input.providerMessageId,
        attemptedAt: input.attemptedAt,
        sentAt: input.sentAt ?? new Date(),
        failureCode: null,
      },
    });
  }

  async markFailed(input: {
    deliveryId: string;
    attemptedAt: Date;
    failureCode: string;
  }): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id: input.deliveryId },
      data: {
        status: 'FAILED',
        attemptedAt: input.attemptedAt,
        failureCode: input.failureCode,
      },
    });
  }

  async claimRetryable(
    input: ClaimRetryableNotificationDelivery,
  ): Promise<boolean> {
    const result = await this.prisma.notificationDelivery.updateMany({
      where: {
        id: input.deliveryId,
        type: input.type,
        status: { in: ['PENDING', 'FAILED'] },
        OR: [
          { attemptedAt: null },
          { attemptedAt: { lte: input.retryBefore } },
        ],
      },
      data: { attemptedAt: input.attemptedAt },
    });
    return result.count === 1;
  }

  async findRetryableIds(
    input: FindRetryableNotificationDeliveries,
  ): Promise<string[]> {
    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: {
        type: input.type,
        status: { in: ['PENDING', 'FAILED'] },
        OR: [
          { attemptedAt: null },
          { attemptedAt: { lte: input.retryBefore } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: input.limit,
    });
    return deliveries.map(({ id }) => id);
  }

  findRecipientSnapshot(
    deliveryId: string,
  ): Promise<{ recipient: string; createdAt: Date } | null> {
    return this.prisma.notificationDelivery.findUnique({
      where: { id: deliveryId },
      select: { recipient: true, createdAt: true },
    });
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.notificationDelivery.deleteMany({
      where: { retentionExpiresAt: { lte: now } },
    });
    return result.count;
  }
}
