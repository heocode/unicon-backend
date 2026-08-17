// NestJS
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Express
import type { Request } from 'express';

// Internal types
import type { SessionMetadata } from '../types/session-metadata.type';
import type { SessionPlatform } from '../../generated/prisma/client';

const MAX_IP_ADDRESS_LENGTH = 45;
const MAX_USER_AGENT_LENGTH = 500;
const MAX_DEVICE_MODEL_IDENTIFIER_LENGTH = 128;
const MAX_DEVICE_MODEL_LENGTH = 100;
const MAX_OS_VERSION_LENGTH = 30;
const MAX_APP_VERSION_LENGTH = 50;

export const SessionContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionMetadata => {
    const request = context.switchToHttp().getRequest<Request>();

    return getSessionMetadata(request);
  },
);

export function getSessionMetadata(request: Request): SessionMetadata {
  return {
    ipAddress: normalizeValue(request.ip, MAX_IP_ADDRESS_LENGTH),
    userAgent: normalizeValue(
      request.headers['user-agent'],
      MAX_USER_AGENT_LENGTH,
    ),
    deviceModelIdentifier: normalizeValue(
      request.headers['x-device-model-identifier'],
      MAX_DEVICE_MODEL_IDENTIFIER_LENGTH,
    ),
    deviceModel: normalizeValue(
      request.headers['x-device-model'],
      MAX_DEVICE_MODEL_LENGTH,
    ),
    platform: normalizePlatform(request.headers['x-platform']),
    osVersion: normalizeValue(
      request.headers['x-os-version'],
      MAX_OS_VERSION_LENGTH,
    ),
    appVersion: normalizeValue(
      request.headers['x-app-version'],
      MAX_APP_VERSION_LENGTH,
    ),
  };
}

function normalizePlatform(
  value: string | string[] | undefined,
): SessionPlatform {
  const platform = normalizeValue(value, 20)?.toUpperCase();

  if (platform === 'IOS' || platform === 'ANDROID' || platform === 'WEB') {
    return platform;
  }

  return 'UNKNOWN';
}

function normalizeValue(
  value: string | string[] | undefined,
  maxLength: number,
): string | undefined {
  const stringValue = Array.isArray(value) ? value[0] : value;

  if (/\p{Cc}/u.test(stringValue ?? '')) {
    return undefined;
  }

  const normalizedValue = stringValue?.trim();

  if (!normalizedValue) {
    return undefined;
  }

  return normalizedValue.slice(0, maxLength);
}
