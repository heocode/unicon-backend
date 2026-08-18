// NestJS
import { ConflictException, Injectable } from '@nestjs/common';

// Internal services
import { PrismaService } from '../../prisma/prisma.service';

// Internal DTOs
import type { ProfileResponseDto } from '../dtos/profile-response.dto';

@Injectable()
export class ProfileQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findMe(userId: string): Promise<ProfileResponseDto> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerified: true,
        role: true,
        createdAt: true,
        university: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!user) {
      throw new ConflictException({
        code: 'PROFILE_UNAVAILABLE',
        message: 'The profile is unavailable.',
      });
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      createdAt: user.createdAt,
      university: {
        id: user.university.id,
        name: user.university.name,
      },
    };
  }
}
