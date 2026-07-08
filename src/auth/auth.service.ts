import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

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

    const isPasswordMatch = await bcrypt.compare(
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

    const tokens = await this.getTokens(existingUser.id, existingUser.username);
    await this.updateRefreshTokenHash(existingUser.id, tokens.refreshToken);

    return tokens;
  }

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
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    // creating username
    const username = await this.generateUsername(email);

    // creating verification token
    const verification = await this.generateVerificationToken();

    // insterting newUser
    const newUser = await this.prisma.user.create({
      data: {
        email: email,
        username: username,
        passwordHash: passwordHash,
        universityId: allowedDomain.universityId,
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

    return {
      message: 'Registration completed successfully. Please verify your email.',
      user: newUser,
    };
  }

  private async generateUsername(email: string): Promise<string> {
    const username = email.split('@')[0];

    for (let i = 0; i < 10; i++) {
      const randomDigits = Math.floor(1000 + Math.random() * 9000);
      const candidateUsername = `${username}${randomDigits}`;

      const existingUsername = await this.prisma.user.findUnique({
        where: { username: candidateUsername },
      });

      if (!existingUsername) {
        return candidateUsername;
      }
    }

    return `${username}${Date.now()}`;
  }

  private async generateVerificationToken(): Promise<{
    token: string;
    hashedToken: string;
    expiresAt: Date;
  }> {
    const token = randomBytes(32).toString('hex');

    const salt = await bcrypt.genSalt(10);
    const hashedToken = await bcrypt.hash(token, salt);

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    return {
      token,
      hashedToken,
      expiresAt,
    };
  }

  async refreshTokens(userId: string, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.hashedRefreshToken) {
      throw new UnauthorizedException('Access Denied. Please log in again.');
    }

    const isRefreshedTokenMatch = await bcrypt.compare(
      refreshToken,
      user.hashedRefreshToken,
    );

    if (!isRefreshedTokenMatch) {
      throw new UnauthorizedException('Access Denied. Invalid token.');
    }

    const tokens = await this.getTokens(user.id, user.username);
    await this.updateRefreshTokenHash(user.id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedRefreshToken: null },
    });
    return { message: 'Logged out successfully.' };
  }

  private async getTokens(userId: string, username: string) {
    const jwtPayload = { sub: userId, username };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(jwtPayload, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(jwtPayload, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private async updateRefreshTokenHash(userId: string, refreshToken: string) {
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(refreshToken, salt);

    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedRefreshToken: hash },
    });
  }
}
