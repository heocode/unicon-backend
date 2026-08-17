// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Prisma
import type { Prisma } from '../../generated/prisma/client';

// Internal services
import { GeoIpService } from '../../geo-ip/geo-ip.service';
import { PrismaService } from '../../prisma/prisma.service';

// Internal types
import type { SessionMetadata } from '../../auth/types/session-metadata.type';
import type {
  CreateSecurityEvent,
  SecurityEventSnapshot,
} from '../types/create-security-event.type';

type SecurityEventClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SecurityEventService {
  private readonly retentionSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoIpService: GeoIpService,
    configService: ConfigService,
  ) {
    this.retentionSeconds = configService.getOrThrow<number>(
      'SECURITY_EVENT_RETENTION_SECONDS',
    );
  }

  snapshotFromMetadata(metadata: SessionMetadata): SecurityEventSnapshot {
    const location = this.geoIpService.lookup(metadata.ipAddress);

    return {
      ...metadata,
      locationCountryCode: location?.countryCode,
      locationCity: location?.city ?? undefined,
    };
  }

  async record(
    event: CreateSecurityEvent,
    client: SecurityEventClient = this.prisma,
  ): Promise<{ id: string }> {
    const occurredAt = event.occurredAt ?? new Date();
    const retentionExpiresAt = new Date(
      occurredAt.getTime() + this.retentionSeconds * 1000,
    );

    return client.securityEvent.create({
      data: {
        ...event,
        occurredAt,
        retentionExpiresAt,
      },
      select: {
        id: true,
      },
    });
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.securityEvent.deleteMany({
      where: {
        retentionExpiresAt: {
          lte: now,
        },
      },
    });

    return result.count;
  }
}
