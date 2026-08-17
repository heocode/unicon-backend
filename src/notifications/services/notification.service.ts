// NestJS
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import { Prisma } from '../../generated/prisma/client';

// Internal services
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';

// Internal types
import type { RiskAssessment } from '../../security/types/risk-assessment.type';

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
          idempotencyKey: `NEW_SESSION:${sessionId}`,
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
        riskLevel: session.subjectSecurityEvents[0]?.riskLevel ?? null,
        riskSignals: session.subjectSecurityEvents[0]?.riskSignals ?? [],
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

  async sendSuspiciousActivityNotification(
    userId: string,
    sessionId: string,
    risk: RiskAssessment,
  ): Promise<void> {
    const session = await this.findSession(userId, sessionId).catch((error) => {
      this.logFailure('Failed to prepare a suspicious-activity alert.', error);
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
          idempotencyKey: `SUSPICIOUS_ACTIVITY:${sessionId}`,
          type: 'SUSPICIOUS_ACTIVITY',
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

      this.logFailure(
        'Failed to create a suspicious-activity delivery.',
        error,
      );
      return;
    }

    const attemptedAt = new Date();

    try {
      const providerMessageId =
        await this.mailService.sendSuspiciousActivityEmail({
          recipient: session.user.email,
          idempotencyKey: delivery.id,
          occurredAt: new Date(),
          deviceModel: session.deviceModel,
          platform: session.platform,
          osVersion: session.osVersion,
          appVersion: session.appVersion,
          locationCountryCode: session.locationCountryCode,
          locationCity: session.locationCity,
          riskLevel: risk.level,
          riskSignals: risk.signals,
        });

      await this.updateSuccessfulDelivery(
        delivery.id,
        providerMessageId,
        attemptedAt,
      );
    } catch (error) {
      await this.updateFailedDelivery(delivery.id, attemptedAt);
      this.logFailure('Failed to send a suspicious-activity email.', error);
    }
  }

  async sendPasswordChangedNotification(
    userId: string,
    securityEventId: string,
  ): Promise<void> {
    const event = await this.findPasswordChangedEvent(
      userId,
      securityEventId,
    ).catch((error) => {
      this.logFailure('Failed to prepare a password-change alert.', error);
      return null;
    });

    if (!event?.user) {
      return;
    }

    let delivery: { id: string };

    try {
      const createdAt = new Date();
      delivery = await this.prisma.notificationDelivery.create({
        data: {
          idempotencyKey: `PASSWORD_CHANGED:${securityEventId}`,
          type: 'PASSWORD_CHANGED',
          channel: 'EMAIL',
          userId,
          sessionId: event.actorSessionId,
          recipient: event.user.email,
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

      this.logFailure('Failed to create a password-change delivery.', error);
      return;
    }

    const attemptedAt = new Date();

    try {
      const providerMessageId = await this.mailService.sendPasswordChangedEmail(
        {
          recipient: event.user.email,
          idempotencyKey: delivery.id,
          occurredAt: event.occurredAt,
          deviceModel: event.deviceModel,
          platform: event.platform,
          osVersion: event.osVersion,
          appVersion: event.appVersion,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
          revokedSessionsCount: event.affectedSessionCount ?? 0,
        },
      );

      await this.updateSuccessfulDelivery(
        delivery.id,
        providerMessageId,
        attemptedAt,
      );
    } catch (error) {
      await this.updateFailedDelivery(delivery.id, attemptedAt);
      this.logFailure('Failed to send a password-change email.', error);
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
        subjectSecurityEvents: {
          where: { type: 'SESSION_CREATED' },
          select: { riskLevel: true, riskSignals: true },
          take: 1,
        },
      },
    });
  }

  private findPasswordChangedEvent(userId: string, securityEventId: string) {
    return this.prisma.securityEvent.findFirst({
      where: {
        id: securityEventId,
        userId,
        type: 'PASSWORD_CHANGED',
      },
      select: {
        actorSessionId: true,
        occurredAt: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
        affectedSessionCount: true,
        user: {
          select: { email: true },
        },
      },
    });
  }

  private async updateSuccessfulDelivery(
    deliveryId: string,
    providerMessageId: string,
    attemptedAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
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
  }

  private async updateFailedDelivery(
    deliveryId: string,
    attemptedAt: Date,
  ): Promise<void> {
    try {
      await this.prisma.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'FAILED',
          attemptedAt,
          failureCode: 'EMAIL_DELIVERY_FAILED',
        },
      });
    } catch (error) {
      this.logFailure('Failed to save a failed email delivery.', error);
    }
  }

  private logFailure(message: string, error: unknown): void {
    this.logger.error(
      message,
      error instanceof Error ? error.stack : undefined,
    );
  }
}
