// Prisma
import type { SessionPlatform } from '../../generated/prisma/client';

// Internal types
import type { SecurityEventSnapshot } from '../types/create-security-event.type';

export const SECURITY_EVENT_SNAPSHOT_SELECT = {
  ipAddress: true,
  userAgent: true,
  deviceModelIdentifier: true,
  deviceModel: true,
  platform: true,
  osVersion: true,
  appVersion: true,
  locationCountryCode: true,
  locationCity: true,
} as const;

export type SecurityEventSnapshotSource = {
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceModelIdentifier?: string | null;
  deviceModel?: string | null;
  platform?: SessionPlatform | null;
  osVersion?: string | null;
  appVersion?: string | null;
  locationCountryCode?: string | null;
  locationCity?: string | null;
};

export function toSecurityEventSnapshot(
  snapshot: SecurityEventSnapshotSource,
): SecurityEventSnapshot {
  return {
    ipAddress: snapshot.ipAddress ?? undefined,
    userAgent: snapshot.userAgent ?? undefined,
    deviceModelIdentifier: snapshot.deviceModelIdentifier ?? undefined,
    deviceModel: snapshot.deviceModel ?? undefined,
    platform: snapshot.platform ?? undefined,
    osVersion: snapshot.osVersion ?? undefined,
    appVersion: snapshot.appVersion ?? undefined,
    locationCountryCode: snapshot.locationCountryCode ?? undefined,
    locationCity: snapshot.locationCity ?? undefined,
  };
}
