import type { SessionPlatform } from '../../generated/prisma/client';

export type SessionMetadata = {
  ipAddress?: string;
  userAgent?: string;
  deviceModelIdentifier?: string;
  deviceModel?: string;
  platform: SessionPlatform;
  osVersion?: string;
  appVersion?: string;
};
