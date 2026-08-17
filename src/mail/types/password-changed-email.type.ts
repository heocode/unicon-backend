// Prisma
import type { SessionPlatform } from '../../generated/prisma/client';

export type PasswordChangedEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
  deviceModel: string | null;
  platform: SessionPlatform | null;
  osVersion: string | null;
  appVersion: string | null;
  locationCountryCode: string | null;
  locationCity: string | null;
  revokedSessionsCount: number;
};
