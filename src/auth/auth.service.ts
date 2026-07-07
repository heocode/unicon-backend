import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {}

  async register(dto: RegisterDto) {
    const email = dto.email.trim().toLowerCase();
    const username = dto.username.trim().toLowerCase();

    // candidate register
    const candidate = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: dto.email }, { username: dto.username }],
      },
    });

    if (candidate) {
      throw new ConflictException(
        'User with this email or username already exists.',
      );
    }

    // email domain checking (e.g my.centennialcollege.ca)
    const emailDomain = dto.email.split('@')[1];
    const allowedDomain = await this.prisma.allowedDomain.findFirst({
      where: { domain: emailDomain },
      include: { university: true },
    });

    if (!allowedDomain || !allowedDomain.active) {
      throw new BadRequestException(
        'Registration with this email domain is not avaliable.',
      );
    }

    // password comparing
    if (!(dto.password == dto.confirmedPassword)) {
      throw new BadRequestException('Passwords do not match.');
    }

    // password bcrypt
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);

    // insterting newUser
    const newUser = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        passwordHash: passwordHash,
        universityId: allowedDomain.universityId,
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
      message: 'registration complete',
      user: newUser,
    };
  }
}
