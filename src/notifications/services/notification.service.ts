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
    await this.queueSafely(async () => {
      const session = await this.findSession(userId, sessionId);
      if (!session) return;
      await this.mailService.sendNewSessionEmail(
        {
          recipient: session.user.email,
          idempotencyKey: `NEW_SESSION:${sessionId}`,
          occurredAt: session.createdAt,
          deviceModel: session.deviceModel,
          platform: session.platform,
          osVersion: session.osVersion,
          appVersion: session.appVersion,
          locationCountryCode: session.locationCountryCode,
          locationCity: session.locationCity,
          riskLevel: session.subjectSecurityEvents[0]?.riskLevel ?? null,
          riskSignals: session.subjectSecurityEvents[0]?.riskSignals ?? [],
        },
        { userId, sessionId },
      );
    });
  }
  async sendSuspiciousActivityNotification(
    userId: string,
    sessionId: string,
    risk: RiskAssessment,
  ): Promise<void> {
    await this.queueSafely(async () => {
      const session = await this.findSession(userId, sessionId);
      if (!session) return;
      await this.mailService.sendSuspiciousActivityEmail(
        {
          recipient: session.user.email,
          idempotencyKey: `SUSPICIOUS_ACTIVITY:${sessionId}`,
          occurredAt: new Date(),
          deviceModel: session.deviceModel,
          platform: session.platform,
          osVersion: session.osVersion,
          appVersion: session.appVersion,
          locationCountryCode: session.locationCountryCode,
          locationCity: session.locationCity,
          riskLevel: risk.level,
          riskSignals: risk.signals,
        },
        { userId, sessionId },
      );
    });
  }
  async sendPasswordChangedNotification(
    userId: string,
    securityEventId: string,
  ): Promise<void> {
    await this.queueSafely(async () => {
      const event = await this.findPasswordChangedEvent(
        userId,
        securityEventId,
      );
      if (!event?.user) return;
      await this.mailService.sendPasswordChangedEmail(
        {
          recipient: event.user.email,
          idempotencyKey: `PASSWORD_CHANGED:${securityEventId}`,
          occurredAt: event.occurredAt,
          deviceModel: event.deviceModel,
          platform: event.platform,
          osVersion: event.osVersion,
          appVersion: event.appVersion,
          locationCountryCode: event.locationCountryCode,
          locationCity: event.locationCity,
          revokedSessionsCount: event.affectedSessionCount ?? 0,
        },
        { userId, sessionId: event.actorSessionId },
      );
    });
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
    await this.queueSafely(async () => {
      const token = await this.prisma.passwordResetToken.findFirst({
        where: { id: tokenId, userId },
        select: { user: { select: { email: true } } },
      });
      if (!token) return;
      await this.mailService.sendPasswordResetRequestEmail(
        {
          recipient: token.user.email,
          idempotencyKey: `PASSWORD_RESET_REQUEST:${tokenId}`,
          token: rawToken,
          expiresInSeconds,
          tokenId,
          userId,
        },
        { userId },
      );
    });
  }
  async sendPasswordResetCompletedNotification(
    userId: string,
    eventId: string,
  ): Promise<void> {
    await this.queueSafely(async () => {
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
      await this.mailService.sendPasswordResetCompletedEmail(
        {
          recipient: event.user.email,
          idempotencyKey: `PASSWORD_RESET_COMPLETED:${eventId}`,
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
        },
        { userId },
      );
    });
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

  private async queueSafely(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch {
      this.logger.error({ event: 'NOTIFICATION_MAIL_ENQUEUE_FAILED' });
    }
  }
}
