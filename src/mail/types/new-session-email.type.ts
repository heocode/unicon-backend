// Prisma
import type { SessionPlatform } from '../../generated/prisma/client';

export type NewSessionEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
  deviceModel: string | null;
  platform: SessionPlatform;
  osVersion: string | null;
  appVersion: string | null;
  locationCountryCode: string | null;
  locationCity: string | null;
};
