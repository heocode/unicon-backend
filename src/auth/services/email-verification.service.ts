// NestJS
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SecureTokenService } from './secure-token.service';
import { SessionCreationService } from '../session/services/session-creation.service';
import { NotificationService } from '../../notifications/services/notification.service';

// Internal utils
import { getVerificationCooldownSeconds } from '../utils/get-verification-cooldown.util';

// Internal errors
import { MailDeliveryError } from '../../common/errors/mail-delivery.error';

// Internal types
import type { SessionMetadata } from '../types/session-metadata.type';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secureTokenService: SecureTokenService,
    private readonly sessionCreationService: SessionCreationService,
    private readonly mailService: MailService,
    private readonly notificationService: NotificationService,
  ) {}

  async sendVerificationEmail(
    userId: string,
    email: string,
    token: string,
  ): Promise<{
    message: string;
    email: string;
    resendAvailableInSeconds: number;
  }> {
    try {
      await this.mailService.sendVerificationEmail(email, token);
    } catch (error) {
      if (error instanceof MailDeliveryError) {
        throw new ServiceUnavailableException({
          code: 'VERIFICATION_EMAIL_UNAVAILABLE',
          message: 'Unable to send verification email. Please try again later.',
        });
      }

      throw error;
    }

    try {
      await this.prisma.user.update({
        where: {
          id: userId,
        },

        data: {
          verificationEmailSentAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `Verification email was sent, but its timestamp was not saved for user ${userId}.`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    return {
      message: 'Verification email sent successfully.',
      email,
      resendAvailableInSeconds: 60,
    };
  }

  async verify(
    token: string,
    metadata: SessionMetadata,
  ): Promise<{
    message: string;
    accessToken: string;
    refreshToken: string;
  }> {
    const hashedToken = this.secureTokenService.hash(token);
    const now = new Date();

    const user = await this.prisma.user.findFirst({
      where: {
        hashedVerificationToken: hashedToken,
      },
      select: {
        id: true,
        emailVerified: true,
        status: true,
        verificationTokenExpires: true,
      },
    });

    if (!user) {
      throw new BadRequestException({
        code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
        message: 'The email verification token is invalid.',
      });
    }

    if (
      !user.verificationTokenExpires ||
      user.verificationTokenExpires <= now
    ) {
      throw new BadRequestException({
        code: 'EMAIL_VERIFICATION_TOKEN_EXPIRED',
        message: 'The email verification token has expired.',
      });
    }

    if (user.emailVerified || user.status !== 'PENDING') {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_VERIFIED',
        message: 'The email has already been verified.',
      });
    }

    const result = await this.prisma.user.updateMany({
      where: {
        id: user.id,
        emailVerified: false,
        status: 'PENDING',
        hashedVerificationToken: hashedToken,
        verificationTokenExpires: {
          gt: now,
        },
      },
      data: {
        emailVerified: true,
        status: 'ACTIVE',
        hashedVerificationToken: null,
        verificationTokenExpires: null,
        verificationEmailSentAt: null,
      },
    });

    if (result.count !== 1) {
      throw new BadRequestException({
        code: 'EMAIL_VERIFICATION_TOKEN_INVALID',
        message: 'The email verification token is invalid.',
      });
    }

    const { sessionId, ...tokens } = await this.sessionCreationService.create(
      user.id,
      metadata,
    );
    await this.notificationService.sendNewSessionNotification(
      user.id,
      sessionId,
    );

    return {
      message: 'Email verified successfully.',
      ...tokens,
    };
  }

  async resend(email: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },

      select: {
        id: true,
        email: true,
        status: true,
        emailVerified: true,
        verificationEmailSentAt: true,
      },
    });

    if (!user || user.status !== 'PENDING' || user.emailVerified) {
      return {
        message: 'Verification email sent successfully.',
      };
    }

    const resendAvailableInSeconds = getVerificationCooldownSeconds(
      user.verificationEmailSentAt,
    );

    if (resendAvailableInSeconds > 0) {
      throw new HttpException(
        {
          code: 'VERIFICATION_EMAIL_COOLDOWN',
          message: 'Please wait before requesting another verification email.',
          details: { retryAfterSeconds: resendAvailableInSeconds },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const verification = this.secureTokenService.generate();

    await this.prisma.user.update({
      where: {
        id: user.id,
      },

      data: {
        hashedVerificationToken: verification.hashedToken,
        verificationTokenExpires: verification.expiresAt,
        verificationEmailSentAt: null,
      },
    });

    await this.sendVerificationEmail(user.id, user.email, verification.token);

    return { message: 'Verification email sent successfully.' };
  }
}
