import { UnauthorizedException } from '@nestjs/common';

import { PrismaService } from '../../../prisma/prisma.service';
import { SessionAuthorizationService } from './session-authorization.service';

describe('SessionAuthorizationService', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');
  const prisma = {
    session: {
      findFirst: jest.fn(),
    },
  };

  let service: SessionAuthorizationService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.clearAllMocks();
    service = new SessionAuthorizationService(
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('accepts an active session for access-token authorization', async () => {
    prisma.session.findFirst.mockResolvedValue({ id: 'session-id' });

    await expect(
      service.assertActive('user-id', 'session-id'),
    ).resolves.toBeUndefined();

    expect(prisma.session.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'session-id',
        userId: 'user-id',
        revokedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });
  });

  it('rejects a revoked, expired, missing, or blocked session', async () => {
    prisma.session.findFirst.mockResolvedValue(null);

    await expect(
      service.assertActive('user-id', 'session-id'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
