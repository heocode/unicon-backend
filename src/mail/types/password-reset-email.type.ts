import type { SessionPlatform } from '../../generated/prisma/client';

export type PasswordResetRequestEmail = {
  recipient: string;
  idempotencyKey: string;
  token: string;
  expiresInSeconds: number;
};

export type PasswordResetCompletedEmail = {
  recipient: string;
  idempotencyKey: string;
  occurredAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  deviceModel: string | null;
  platform: SessionPlatform | null;
  osVersion: string | null;
  appVersion: string | null;
  locationCountryCode: string | null;
  locationCity: string | null;
  revokedSessionsCount: number;
};
