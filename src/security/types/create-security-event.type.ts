// Prisma
import type {
  SecurityEventReason,
  SecurityEventType,
  SessionPlatform,
} from '../../generated/prisma/client';

export type SecurityEventSnapshot = {
  ipAddress?: string;
  userAgent?: string;
  deviceModel?: string;
  platform?: SessionPlatform;
  osVersion?: string;
  appVersion?: string;
  locationCountryCode?: string;
  locationCity?: string;
};

export type CreateSecurityEvent = SecurityEventSnapshot & {
  type: SecurityEventType;
  reason?: SecurityEventReason;
  userId?: string;
  actorSessionId?: string;
  subjectSessionId?: string;
  affectedSessionCount?: number;
  occurredAt?: Date;
};
