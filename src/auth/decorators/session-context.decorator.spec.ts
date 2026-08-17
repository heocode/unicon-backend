import type { Request } from 'express';
import { getSessionMetadata } from './session-context.decorator';

describe('getSessionMetadata', () => {
  it('extracts and normalizes session metadata from the request', () => {
    const request = {
      ip: ' 192.0.2.10 ',
      headers: {
        'user-agent': ' Unicon/1.0 (iOS 18) ',
        'x-device-model-identifier': ' iPhone17,1 ',
        'x-device-model': ' iPhone 16 Pro ',
        'x-platform': ' ios ',
        'x-os-version': ' 18.6 ',
        'x-app-version': ' 1.4.2 ',
      },
    } as Request;

    expect(getSessionMetadata(request)).toEqual({
      ipAddress: '192.0.2.10',
      userAgent: 'Unicon/1.0 (iOS 18)',
      deviceModelIdentifier: 'iPhone17,1',
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      osVersion: '18.6',
      appVersion: '1.4.2',
    });
  });

  it('turns empty values into undefined', () => {
    const request = {
      ip: '',
      headers: {
        'user-agent': ' ',
        'x-device-model-identifier': '',
        'x-device-model': '',
        'x-platform': '',
        'x-os-version': '',
        'x-app-version': '',
      },
    } as Request;

    expect(getSessionMetadata(request)).toEqual({
      ipAddress: undefined,
      userAgent: undefined,
      deviceModelIdentifier: undefined,
      deviceModel: undefined,
      platform: 'UNKNOWN',
      osVersion: undefined,
      appVersion: undefined,
    });
  });

  it('limits client-controlled metadata lengths', () => {
    const request = {
      ip: 'a'.repeat(60),
      headers: {
        'user-agent': 'b'.repeat(600),
        'x-device-model-identifier': 'f'.repeat(160),
        'x-device-model': 'c'.repeat(150),
        'x-os-version': 'd'.repeat(50),
        'x-app-version': 'e'.repeat(70),
      },
    } as Request;

    const metadata = getSessionMetadata(request);

    expect(metadata.ipAddress).toHaveLength(45);
    expect(metadata.userAgent).toHaveLength(500);
    expect(metadata.deviceModelIdentifier).toHaveLength(128);
    expect(metadata.deviceModel).toHaveLength(100);
    expect(metadata.osVersion).toHaveLength(30);
    expect(metadata.appVersion).toHaveLength(50);
    expect(metadata.platform).toBe('UNKNOWN');
  });

  it('uses the first header value and preserves identifier casing', () => {
    const request = {
      ip: '192.0.2.10',
      headers: {
        'x-device-model-identifier': [' Pixel_9.Pro ', 'ignored-value'],
      },
    } as Request;

    expect(getSessionMetadata(request).deviceModelIdentifier).toBe(
      'Pixel_9.Pro',
    );
  });

  it('drops metadata containing control characters', () => {
    const request = {
      ip: '192.0.2.10',
      headers: {
        'user-agent': 'Unicon\u0000Client',
        'x-device-model-identifier': 'iPhone17,1\nInjected',
        'x-device-model': 'iPhone\t16 Pro',
        'x-os-version': '18.6\rInjected',
        'x-app-version': '1.4.2\u007f',
      },
    } as Request;

    expect(getSessionMetadata(request)).toMatchObject({
      userAgent: undefined,
      deviceModelIdentifier: undefined,
      deviceModel: undefined,
      osVersion: undefined,
      appVersion: undefined,
    });
  });
});
