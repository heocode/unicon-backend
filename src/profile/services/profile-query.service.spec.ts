import { UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { ProfileQueryService } from './profile-query.service';

describe('ProfileQueryService', () => {
  const prisma = {
    user: {
      findFirst: jest.fn(),
    },
  };

  let service: ProfileQueryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ProfileQueryService(prisma as unknown as PrismaService);
  });

  it('returns only the public profile and university fields', async () => {
    const createdAt = new Date('2026-08-16T12:00:00.000Z');
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-id',
      username: 'student',
      email: 'student@example.edu',
      emailVerified: true,
      role: 'MEMBER',
      createdAt,
      university: {
        id: 'university-id',
        name: 'Example University',
      },
    });

    await expect(service.findMe('user-id')).resolves.toEqual({
      id: 'user-id',
      username: 'student',
      email: 'student@example.edu',
      emailVerified: true,
      role: 'MEMBER',
      createdAt,
      university: {
        id: 'university-id',
        name: 'Example University',
      },
    });

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'user-id',
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
  });

  it('rejects an unavailable profile with a stable error code', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(
      service.findMe('user-id'),
    ).rejects.toMatchObject<UnauthorizedException>({
      response: {
        code: 'PROFILE_UNAVAILABLE',
        message: 'The profile is unavailable.',
      },
    });
  });
});
