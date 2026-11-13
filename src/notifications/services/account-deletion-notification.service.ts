import { Injectable, Logger } from '@nestjs/common';

import type { Prisma } from '../../generated/prisma/client';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AccountDeletionNotificationService {
  private readonly logger = new Logger(AccountDeletionNotificationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  async sendDeletionRequested(
    userId: string,
    securityEventId: string,
    deletionScheduledAt: Date,
  ): Promise<void> {
    try {
      const event = await this.prisma.securityEvent.findFirst({
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
          user: { select: { email: true } },
        },
      });
      if (!event?.user) return;
      await this.mailService.sendAccountDeletionRequestedEmail(
        {
          recipient: event.user.email,
          idempotencyKey: `ACCOUNT_DELETION_REQUESTED:${securityEventId}`,
          occurredAt: event.occurredAt,
          deletionScheduledAt,
          revokedSessionsCount: event.affectedSessionCount ?? 0,
          deviceModel: event.deviceModel,
          platform: event.platform,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
        },
        { userId },
      );
    } catch {
      this.logger.error({ event: 'DELETION_REQUEST_MAIL_ENQUEUE_FAILED' });
    }
  }
  async sendDeletionCancelled(
    userId: string,
    securityEventId: string,
  ): Promise<void> {
    try {
      const event = await this.prisma.securityEvent.findFirst({
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
      });
      if (!event?.user) return;
      await this.mailService.sendAccountDeletionCancelledEmail(
        {
          recipient: event.user.email,
          idempotencyKey: `ACCOUNT_DELETION_CANCELLED:${securityEventId}`,
          occurredAt: event.occurredAt,
          deviceModel: event.deviceModel,
          platform: event.platform,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
        },
        { userId },
      );
    } catch {
      this.logger.error({ event: 'DELETION_CANCEL_MAIL_ENQUEUE_FAILED' });
    }
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
    const id = await this.mailService.sendAccountDeletedEmail(
      {
        recipient: input.recipient,
        idempotencyKey: `ACCOUNT_DELETED:${input.securityEventId}`,
        occurredAt: input.occurredAt,
      },
      { userId: input.userId },
      transaction,
    );
    return { id };
  }
}
