// NestJS
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import { Prisma } from '../../generated/prisma/client';

// Internal services
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly retentionSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    configService: ConfigService,
  ) {
    this.retentionSeconds = configService.getOrThrow<number>(
      'NOTIFICATION_DELIVERY_RETENTION_SECONDS',
    );
  }

  async sendNewSessionNotification(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.findSession(userId, sessionId).catch((error) => {
      this.logFailure('Failed to prepare a new-session notification.', error);
      return null;
    });

    if (!session) {
      return;
    }

    let delivery: { id: string };

    try {
      const createdAt = new Date();
      delivery = await this.prisma.notificationDelivery.create({
        data: {
          type: 'NEW_SESSION',
          channel: 'EMAIL',
          userId,
          sessionId,
          recipient: session.user.email,
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
        return;
      }

      this.logFailure('Failed to create a notification delivery.', error);
      return;
    }

    const attemptedAt = new Date();

    try {
      const providerMessageId = await this.mailService.sendNewSessionEmail({
        recipient: session.user.email,
        idempotencyKey: delivery.id,
        occurredAt: session.createdAt,
        deviceModel: session.deviceModel,
        platform: session.platform,
        osVersion: session.osVersion,
        appVersion: session.appVersion,
        locationCountryCode: session.locationCountryCode,
        locationCity: session.locationCity,
      });

      try {
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'SENT',
            providerMessageId,
            attemptedAt,
            sentAt: new Date(),
            failureCode: null,
          },
        });
      } catch (error) {
        this.logFailure('Failed to save a successful email delivery.', error);
      }
    } catch (error) {
      try {
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'FAILED',
            attemptedAt,
            failureCode: 'EMAIL_DELIVERY_FAILED',
          },
        });
      } catch (statusError) {
        this.logFailure('Failed to save a failed email delivery.', statusError);
      }

      this.logFailure('Failed to send a new-session email.', error);
    }
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.notificationDelivery.deleteMany({
      where: { retentionExpiresAt: { lte: now } },
    });

    return result.count;
  }

  private findSession(userId: string, sessionId: string) {
    return this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      select: {
        createdAt: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
        user: {
          select: { email: true },
        },
      },
    });
  }

  private logFailure(message: string, error: unknown): void {
    this.logger.error(
      message,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
