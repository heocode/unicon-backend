// NestJS
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';

// Prisma
import { Prisma } from '../generated/prisma/client';

// Internal services
import { PrismaService } from '../prisma/prisma.service';
import { SecurityEventService } from '../security/services/security-event.service';
import { NotificationService } from '../notifications/services/notification.service';
import { PasswordService } from './password/services/password.service';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';
import { EmailVerificationService } from './services/email-verification.service';
import { SessionCreationService } from './session/services/session-creation.service';
import { SessionRefreshService } from './session/services/session-refresh.service';
import { SessionQueryService } from './session/services/session-query.service';
import { SessionManagementService } from './session/services/session-management.service';

// Internal utils
import { getVerificationCooldownSeconds } from './utils/get-verification-cooldown.util';

// Internal types
import type { SecureToken } from './types/secure-token.type';
import type { SessionMetadata } from './types/session-metadata.type';

// DTOs
import type { LoginDto } from './dtos/login.dto';
import type { RegisterDto } from './dtos/register.dto';
import type { VerifyEmailDto } from './dtos/verify-email.dto';
import type { ResendVerificationDto } from './dtos/resend-verification.dto';
import type { UpdateSessionDto } from './dtos/update-session.dto';

type CreatePendingUserParams = {
  email: string;
  passwordHash: string;
  universityId: string;
  verification: SecureToken;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly secureTokenService: SecureTokenService,
    private readonly usernameService: UsernameService,
    private readonly sessionCreationService: SessionCreationService,
    private readonly sessionRefreshService: SessionRefreshService,
    private readonly sessionQueryService: SessionQueryService,
    private readonly sessionManagementService: SessionManagementService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly securityEventService: SecurityEventService,
    private readonly notificationService: NotificationService,
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email;

    if (dto.password !== dto.confirmedPassword) {
      throw new BadRequestException('Passwords do not match.');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
      },
    });

    if (existingUser) {
      throw new ConflictException('Email is already taken.');
    }

    const emailDomain = email.split('@')[1];
    const allowedDomain = await this.prisma.allowedDomain.findFirst({
      where: {
        domain: emailDomain,
        active: true,
      },
      select: {
        universityId: true,
      },
    });

    if (!allowedDomain) {
      throw new BadRequestException(
        'Registration with this email domain is not available.',
      );
    }

    const passwordHash = await this.passwordService.hash(dto.password);

    const verification = this.secureTokenService.generate();

    const newUser = await this.createPendingUser({
      email,
      passwordHash,
      verification,
      universityId: allowedDomain.universityId,
    });

    return this.emailVerificationService.sendVerificationEmail(
      newUser.id,
      newUser.email,
      verification.token,
    );
  }

  async login(dto: LoginDto, metadata: SessionMetadata) {
    const email = dto.email;

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        status: true,
        verificationEmailSentAt: true,
      },
    });

    if (!existingUser) {
      await this.recordFailedLogin(metadata);
      throw new UnauthorizedException('Invalid email or password.');
    }

    const passwordMatches = await this.passwordService.compare(
      dto.password,
      existingUser.passwordHash,
    );

    if (!passwordMatches) {
      await this.recordFailedLogin(metadata, existingUser.id);
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (existingUser.status === 'PENDING') {
      const resendAvailableInSeconds = getVerificationCooldownSeconds(
        existingUser.verificationEmailSentAt,
      );

      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your student email before continuing.',
        email: existingUser.email,
        resendAvailableInSeconds,
      });
    }

    if (existingUser.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'ACCOUNT_UNAVAILABLE',
        message: 'This account is not available.',
      });
    }

    await this.securityEventService.record({
      type: 'LOGIN_SUCCEEDED',
      userId: existingUser.id,
      ...this.securityEventService.snapshotFromMetadata(metadata),
    });

    const { sessionId, ...tokens } = await this.sessionCreationService.create(
      existingUser.id,
      metadata,
    );
    await this.notificationService.sendNewSessionNotification(
      existingUser.id,
      sessionId,
    );

    return tokens;
  }

  async logout(userId: string, sessionId: string) {
    await this.sessionManagementService.revoke(userId, sessionId);

    return {
      message: 'Logged out successfully.',
    };
  }

  getSessions(userId: string, currentSessionId: string) {
    return this.sessionQueryService.findActiveByUser(userId, currentSessionId);
  }

  renameSession(
    userId: string,
    currentSessionId: string,
    targetSessionId: string,
    dto: UpdateSessionDto,
  ) {
    return this.sessionManagementService.rename(
      userId,
      currentSessionId,
      targetSessionId,
      dto.sessionName,
    );
  }

  revokeSession(
    userId: string,
    currentSessionId: string,
    targetSessionId: string,
  ) {
    return this.sessionManagementService.revokeSelected(
      userId,
      currentSessionId,
      targetSessionId,
    );
  }

  revokeOtherSessions(userId: string, currentSessionId: string) {
    return this.sessionManagementService.revokeOthers(userId, currentSessionId);
  }

  private async createPendingUser({
    email,
    passwordHash,
    universityId,
    verification,
  }: CreatePendingUserParams) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const username = this.usernameService.generate(email);

      try {
        return await this.prisma.user.create({
          data: {
            email,
            username,
            passwordHash,
            universityId,
            status: 'PENDING',
            hashedVerificationToken: verification.hashedToken,
            verificationTokenExpires: verification.expiresAt,
          },
          select: {
            id: true,
            email: true,
            username: true,
            role: true,
            universityId: true,
            createdAt: true,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const target = error.meta?.target;

          if (Array.isArray(target)) {
            if (target.includes('username')) {
              continue;
            }

            if (target.includes('email')) {
              throw new ConflictException('Email is already taken.');
            }
          }
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Unable to generate a unique username. Please try again.',
    );
  }

  verifyEmail(dto: VerifyEmailDto, metadata: SessionMetadata) {
    return this.emailVerificationService.verify(dto.token, metadata);
  }

  resendVerification(dto: ResendVerificationDto) {
    const email = dto.email;
    return this.emailVerificationService.resend(email);
  }

  refreshTokens(userId: string, sessionId: string, refreshToken: string) {
    return this.sessionRefreshService.refresh(userId, sessionId, refreshToken);
  }

  private async recordFailedLogin(
    metadata: SessionMetadata,
    userId?: string,
  ): Promise<void> {
    try {
      await this.securityEventService.record({
        type: 'LOGIN_FAILED',
        reason: 'INVALID_CREDENTIALS',
        userId,
        ...this.securityEventService.snapshotFromMetadata(metadata),
      });
    } catch (error) {
      this.logger.error(
        'Failed to record a rejected login attempt.',
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
