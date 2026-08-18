// Prisma
import type { SessionPlatform } from '../../generated/prisma/client';

export type AccountDeletionRequestedEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
  deletionScheduledAt: Date;
  revokedSessionsCount: number;
  deviceModel: string | null;
  platform: SessionPlatform | null;
  locationCountryCode: string | null;
  locationCity: string | null;
};

export type AccountDeletionCancelledEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
  deviceModel: string | null;
  platform: SessionPlatform | null;
  locationCountryCode: string | null;
  locationCity: string | null;
};

export type AccountDeletedEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
};
