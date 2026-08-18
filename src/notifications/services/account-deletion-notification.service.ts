// NestJS
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import { Prisma, type NotificationType } from '../../generated/prisma/client';

// Internal services
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

@Injectable()
export class AccountDeletionNotificationService {
  private readonly logger = new Logger(AccountDeletionNotificationService.name);
  private readonly completionRetrySeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly deliveryService: NotificationDeliveryService,
    configService: ConfigService,
  ) {
    this.completionRetrySeconds = configService.getOrThrow<number>(
      'ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS',
    );
  }

  async sendDeletionRequested(
    userId: string,
    securityEventId: string,
    deletionScheduledAt: Date,
  ): Promise<void> {
    const event = await this.prisma.securityEvent
      .findFirst({
        where: {
          id: securityEventId,
          userId,
          type: 'ACCOUNT_DELETION_REQUESTED',
        },
        select: {
          occurredAt: true,
          deviceModel: true,
          platform: true,
          locationCountryCode: true,
          locationCity: true,
          affectedSessionCount: true,
          user: {
            select: { email: true },
          },
        },
      })
      .catch((error) => {
        this.logFailure(
          'Failed to prepare an account-deletion request notification.',
          error,
        );
        return null;
      });

    if (!event?.user) return;
    const recipient = event.user.email;

    await this.deliver(
      `ACCOUNT_DELETION_REQUESTED:${securityEventId}`,
      'ACCOUNT_DELETION_REQUESTED',
      userId,
      recipient,
      (deliveryId) =>
        this.mailService.sendAccountDeletionRequestedEmail({
          recipient,
          idempotencyKey: deliveryId,
          occurredAt: event.occurredAt,
          deletionScheduledAt,
          revokedSessionsCount: event.affectedSessionCount ?? 0,
          deviceModel: event.deviceModel,
          platform: event.platform,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
        }),
    );
  }

  async sendDeletionCancelled(
    userId: string,
    securityEventId: string,
  ): Promise<void> {
    const event = await this.prisma.securityEvent
      .findFirst({
        where: {
          id: securityEventId,
          userId,
          type: 'ACCOUNT_DELETION_CANCELLED',
        },
        select: {
          occurredAt: true,
          deviceModel: true,
          platform: true,
          locationCountryCode: true,
          locationCity: true,
          user: { select: { email: true } },
        },
      })
      .catch((error) => {
        this.logFailure(
          'Failed to prepare an account-deletion cancellation notification.',
          error,
        );
        return null;
      });

    if (!event?.user) return;
    const recipient = event.user.email;

    await this.deliver(
      `ACCOUNT_DELETION_CANCELLED:${securityEventId}`,
      'ACCOUNT_DELETION_CANCELLED',
      userId,
      recipient,
      (deliveryId) =>
        this.mailService.sendAccountDeletionCancelledEmail({
          recipient,
          idempotencyKey: deliveryId,
          occurredAt: event.occurredAt,
          deviceModel: event.deviceModel,
          platform: event.platform,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
        }),
    );
  }

  async prepareDeletionCompleted(
    transaction: Prisma.TransactionClient,
    input: {
      userId: string;
      securityEventId: string;
      recipient: string;
      occurredAt: Date;
    },
  ): Promise<{ id: string }> {
    const delivery = await this.deliveryService.createIdempotent(
      {
        idempotencyKey: `ACCOUNT_DELETED:${input.securityEventId}`,
        type: 'ACCOUNT_DELETED',
        userId: input.userId,
        recipient: input.recipient,
        createdAt: input.occurredAt,
      },
      transaction,
    );
    if (!delivery) {
      throw new Error('Account-deleted notification delivery already exists.');
    }
    return delivery;
  }

  async sendPreparedDeletionCompleted(deliveryId: string): Promise<boolean> {
    const attemptedAt = new Date();
    const retryBefore = new Date(
      attemptedAt.getTime() - this.completionRetrySeconds * 1000,
    );
    const claimed = await this.deliveryService.claimRetryable({
      deliveryId,
      type: 'ACCOUNT_DELETED',
      attemptedAt,
      retryBefore,
    });

    if (!claimed) return false;

    const delivery =
      await this.deliveryService.findRecipientSnapshot(deliveryId);
    if (!delivery) return false;

    try {
      const providerMessageId = await this.mailService.sendAccountDeletedEmail({
        recipient: delivery.recipient,
        idempotencyKey: deliveryId,
        occurredAt: delivery.createdAt,
      });
      await this.updateSuccessfulDelivery(
        deliveryId,
        providerMessageId,
        attemptedAt,
      );
    } catch (error) {
      await this.updateFailedDelivery(deliveryId, attemptedAt);
      this.logFailure('Failed to send an account-deleted email.', error);
    }

    return true;
  }

  async retryDeletionCompleted(limit: number): Promise<number> {
    const retryBefore = new Date(
      Date.now() - this.completionRetrySeconds * 1000,
    );
    const deliveryIds = await this.deliveryService.findRetryableIds({
      type: 'ACCOUNT_DELETED',
      retryBefore,
      limit,
    });

    let attempted = 0;
    for (const deliveryId of deliveryIds) {
      if (await this.sendPreparedDeletionCompleted(deliveryId)) attempted++;
    }
    return attempted;
  }

  private async deliver(
    idempotencyKey: string,
    type: NotificationType,
    userId: string,
    recipient: string,
    send: (deliveryId: string) => Promise<string>,
  ): Promise<void> {
    let delivery: { id: string } | null;

    try {
      delivery = await this.deliveryService.createIdempotent({
        idempotencyKey,
        type,
        userId,
        recipient,
      });
    } catch (error) {
      this.logFailure(
        'Failed to create an account-deletion notification delivery.',
        error,
      );
      return;
    }
    if (!delivery) return;

    const attemptedAt = new Date();

    try {
      const providerMessageId = await send(delivery.id);
      await this.updateSuccessfulDelivery(
        delivery.id,
        providerMessageId,
        attemptedAt,
      );
    } catch (error) {
      await this.updateFailedDelivery(delivery.id, attemptedAt);
      this.logFailure('Failed to send an account-deletion email.', error);
    }
  }

  private async updateSuccessfulDelivery(
    deliveryId: string,
    providerMessageId: string,
    attemptedAt: Date,
  ): Promise<void> {
    try {
      await this.deliveryService.markSent({
        deliveryId,
        providerMessageId,
        attemptedAt,
      });
    } catch (error) {
      this.logFailure(
        'Failed to save a successful account-deletion delivery.',
        error,
      );
    }
  }

  private async updateFailedDelivery(
    deliveryId: string,
    attemptedAt: Date,
  ): Promise<void> {
    try {
      await this.deliveryService.markFailed({
        deliveryId,
        attemptedAt,
        failureCode: 'EMAIL_DELIVERY_FAILED',
      });
    } catch (error) {
      this.logFailure(
        'Failed to save a failed account-deletion delivery.',
        error,
      );
    }
  }

  private logFailure(message: string, error: unknown): void {
    this.logger.error(
      message,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
