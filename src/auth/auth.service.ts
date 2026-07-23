// NestJS
import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

// Prisma
import { Prisma } from '../generated/prisma/client';

// Internal services
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './services/password.service';
import { SecureTokenService } from './services/secure-token.service';
import { UsernameService } from './services/username.service';
import { SessionService } from './services/session.service';

// Internal types
import { SecureToken } from './types/secure-token.type';

// DTOs
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

type CreatePendingUserParams = {
  email: string;
  passwordHash: string;
  universityId: string;
  verification: SecureToken;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly secureTokenService: SecureTokenService,
    private readonly usernameService: UsernameService,
    private readonly sessionService: SessionService,
  ) {}

  // public methods
  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();

    // password comparing
    if (dto.password !== dto.confirmedPassword) {
      throw new BadRequestException('Passwords do not match.');
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    // user already in db checking
    if (existingUser) {
      throw new ConflictException('Email is already taken.');
    }

    // email domain checking (e.g my.centennialcollege.ca)
    const emailDomain = email.split('@')[1];
    const allowedDomain = await this.prisma.allowedDomain.findFirst({
      where: { domain: emailDomain },
    });

    if (!allowedDomain || !allowedDomain.active) {
      throw new BadRequestException(
        'Registration with this email domain is not available.',
      );
    }

    // password bcrypt
    const passwordHash = await this.passwordService.hash(dto.password);

    // creating verification token
    const verification = this.secureTokenService.generate();

    // insterting newUser
    const newUser = await this.createPendingUser({
      email,
      passwordHash,
      verification,
      universityId: allowedDomain.universityId,
    });

    return {
      message: 'Registration completed successfully. Please verify your email.',
      user: newUser,
    };
  }

  async login(
    dto: LoginDto,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const email = dto.email.trim().toLowerCase();
    const password = dto.password;
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!existingUser) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const isPasswordMatch = await this.passwordService.compare(
      password,
      existingUser.passwordHash,
    );

    if (!isPasswordMatch) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (existingUser.status === 'PENDING') {
      throw new UnauthorizedException(
        'Please verify your email before logging in.',
      );
    }

    if (existingUser.status === 'BLOCKED') {
      throw new UnauthorizedException(
        'Your account has been blocked. Please contact support.',
      );
    }

    if (existingUser.status === 'DELETED') {
      throw new UnauthorizedException('This account is no longer available.');
    }

    return this.sessionService.create(existingUser);
  }

  async logout(userId: string, sessionId: string) {
    await this.sessionService.revoke(userId, sessionId);

    return {
      message: 'Logged out successfully.',
    };
  }

  async refreshTokens(userId: string, sessionId: string, refreshToken: string) {
    return this.sessionService.refresh(userId, sessionId, refreshToken);
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

          if (Array.isArray(target) && target.includes('username')) {
            continue;
          }
        }

        throw error;
      }
    }

    throw new ConflictException(
      'Unable to generate a unique username. Please try again.',
    );
  }
}
