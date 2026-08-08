// NestJS
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../mail/mail.service';
import { SecureTokenService } from './secure-token.service';
import { SessionService } from './session.service';

// Internal utils
import { getVerificationCooldownSeconds } from '../utils/get-verification-cooldown.util';

// Internal errors
import { MailDeliveryError } from '../../common/errors/mail-delivery.error';

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secureTokenService: SecureTokenService,
    private readonly sessionService: SessionService,
    private readonly mailService: MailService,
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
        throw new ServiceUnavailableException(
          'Unable to send verification email. Please try again later.',
        );
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

  async verify(token: string): Promise<{
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
      throw new UnauthorizedException('The verification token is invalid.');
    }

    if (
      !user.verificationTokenExpires ||
      user.verificationTokenExpires <= now
    ) {
      throw new BadRequestException('The verification token has expired.');
    }

    if (user.emailVerified || user.status !== 'PENDING') {
      throw new BadRequestException('The email has already been verified.');
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
      throw new BadRequestException(
        'The verification token is invalid, expired, or has already been used.',
      );
    }

    const tokens = await this.sessionService.create(user.id);

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
          resendAvailableInSeconds,
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

    return this.sendVerificationEmail(user.id, user.email, verification.token);
  }
}
