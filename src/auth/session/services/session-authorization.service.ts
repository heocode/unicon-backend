// NestJS
import { Injectable, UnauthorizedException } from '@nestjs/common';

// Internal services
import { PrismaService } from '../../../prisma/prisma.service';

@Injectable()
export class SessionAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertActive(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { status: 'ACTIVE' },
      },
      select: { id: true },
    });

    if (!session) {
      throw new UnauthorizedException('Access Denied. Session unavailable.');
    }
  }
}
