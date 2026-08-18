// NestJS
import { applyDecorators } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

export function ApiSessionMetadataHeaders() {
  return applyDecorators(
    ApiHeader({
      name: 'User-Agent',
      required: false,
      description:
        'Informational client user agent. Maximum 500 characters. It is not a security credential.',
    }),
    ApiHeader({
      name: 'X-Device-Model-Identifier',
      required: false,
      description:
        'Informational, client-supplied technical device identifier. Maximum 128 characters. For example iPhone17,1.',
    }),
    ApiHeader({
      name: 'X-Device-Model',
      required: false,
      description:
        'Informational, client-supplied display name. Maximum 100 characters. For example iPhone 16 Pro.',
    }),
    ApiHeader({
      name: 'X-Platform',
      required: false,
      description:
        'Informational client platform: IOS, ANDROID, WEB, or UNKNOWN. Unrecognized values become UNKNOWN.',
    }),
    ApiHeader({
      name: 'X-OS-Version',
      required: false,
      description:
        'Informational operating system version. Maximum 30 characters.',
    }),
    ApiHeader({
      name: 'X-App-Version',
      required: false,
      description:
        'Informational Unicon application version. Maximum 50 characters.',
    }),
  );
}
