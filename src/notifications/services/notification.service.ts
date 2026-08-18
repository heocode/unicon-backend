// NestJS
import { Injectable, Logger } from '@nestjs/common';

// Internal services
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationDeliveryService } from './notification-delivery.service';

// Internal types
import type { RiskAssessment } from '../../security/types/risk-assessment.type';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly deliveryService: NotificationDeliveryService,
  ) {}

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

    let delivery: { id: string } | null;

    try {
      delivery = await this.deliveryService.createIdempotent({
        idempotencyKey: `NEW_SESSION:${sessionId}`,
        type: 'NEW_SESSION',
        userId,
        sessionId,
        recipient: session.user.email,
      });
    } catch (error) {
      this.logFailure('Failed to create a notification delivery.', error);
      return;
    }
    if (!delivery) return;

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
        await this.deliveryService.markSent({
          deliveryId: delivery.id,
          providerMessageId,
          attemptedAt,
        });
      } catch (error) {
        this.logFailure('Failed to save a successful email delivery.', error);
      }
    } catch (error) {
      try {
        await this.deliveryService.markFailed({
          deliveryId: delivery.id,
          attemptedAt,
          failureCode: 'EMAIL_DELIVERY_FAILED',
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

    let delivery: { id: string } | null;

    try {
      delivery = await this.deliveryService.createIdempotent({
        idempotencyKey: `SUSPICIOUS_ACTIVITY:${sessionId}`,
        type: 'SUSPICIOUS_ACTIVITY',
        userId,
        sessionId,
        recipient: session.user.email,
      });
    } catch (error) {
      this.logFailure(
        'Failed to create a suspicious-activity delivery.',
        error,
      );
      return;
    }
    if (!delivery) return;

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

    let delivery: { id: string } | null;

    try {
      delivery = await this.deliveryService.createIdempotent({
        idempotencyKey: `PASSWORD_CHANGED:${securityEventId}`,
        type: 'PASSWORD_CHANGED',
        userId,
        sessionId: event.actorSessionId,
        recipient: event.user.email,
      });
    } catch (error) {
      this.logFailure('Failed to create a password-change delivery.', error);
      return;
    }
    if (!delivery) return;

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
    return this.deliveryService.deleteExpired(now);
  }

  async sendPasswordResetRequestNotification(
    userId: string,
    tokenId: string,
    rawToken: string,
    expiresInSeconds: number,
  ): Promise<void> {
    const token = await this.prisma.passwordResetToken.findFirst({
      where: { id: tokenId, userId },
      select: { user: { select: { email: true } } },
    });
    if (!token) return;

    await this.deliverPasswordReset(
      `PASSWORD_RESET_REQUEST:${tokenId}`,
      'PASSWORD_RESET_REQUEST',
      userId,
      token.user.email,
      (deliveryId) =>
        this.mailService.sendPasswordResetRequestEmail({
          recipient: token.user.email,
          idempotencyKey: deliveryId,
          token: rawToken,
          expiresInSeconds,
        }),
    );
  }

  async sendPasswordResetCompletedNotification(
    userId: string,
    eventId: string,
  ): Promise<void> {
    const event = await this.prisma.securityEvent.findFirst({
      where: { id: eventId, userId, type: 'PASSWORD_RESET_COMPLETED' },
      select: {
        occurredAt: true,
        ipAddress: true,
        userAgent: true,
        deviceModel: true,
        platform: true,
        osVersion: true,
        appVersion: true,
        locationCountryCode: true,
        locationCity: true,
        affectedSessionCount: true,
        user: { select: { email: true } },
      },
    });
    if (!event?.user) return;

    await this.deliverPasswordReset(
      `PASSWORD_RESET_COMPLETED:${eventId}`,
      'PASSWORD_RESET_COMPLETED',
      userId,
      event.user.email,
      (deliveryId) =>
        this.mailService.sendPasswordResetCompletedEmail({
          recipient: event.user!.email,
          idempotencyKey: deliveryId,
          occurredAt: event.occurredAt,
          ipAddress: event.ipAddress,
          userAgent: event.userAgent,
          deviceModel: event.deviceModel,
          platform: event.platform,
          osVersion: event.osVersion,
          appVersion: event.appVersion,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
          revokedSessionsCount: event.affectedSessionCount ?? 0,
        }),
    );
  }

  private async deliverPasswordReset(
    idempotencyKey: string,
    type: 'PASSWORD_RESET_REQUEST' | 'PASSWORD_RESET_COMPLETED',
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
      this.logFailure('Failed to create a password-reset delivery.', error);
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
      this.logFailure('Failed to send a password-reset email.', error);
    }
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
      await this.deliveryService.markSent({
        deliveryId,
        providerMessageId,
        attemptedAt,
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
      await this.deliveryService.markFailed({
        deliveryId,
        attemptedAt,
        failureCode: 'EMAIL_DELIVERY_FAILED',
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
