import type { Request } from 'express';
import { getSessionMetadata } from './session-context.decorator';

describe('getSessionMetadata', () => {
  it('extracts and normalizes session metadata from the request', () => {
    const request = {
      ip: ' 192.0.2.10 ',
      headers: {
        'user-agent': ' Unicon/1.0 (iOS 18) ',
        'x-device-model': ' iPhone 16 Pro ',
        'x-platform': ' ios ',
        'x-os-version': ' 18.6 ',
        'x-app-version': ' 1.4.2 ',
      },
    } as Request;

    expect(getSessionMetadata(request)).toEqual({
      ipAddress: '192.0.2.10',
      userAgent: 'Unicon/1.0 (iOS 18)',
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
        'x-device-model': '',
        'x-platform': '',
        'x-os-version': '',
        'x-app-version': '',
      },
    } as Request;

    expect(getSessionMetadata(request)).toEqual({
      ipAddress: undefined,
      userAgent: undefined,
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
        'x-device-model': 'c'.repeat(150),
        'x-os-version': 'd'.repeat(50),
        'x-app-version': 'e'.repeat(70),
      },
    } as Request;

    const metadata = getSessionMetadata(request);

    expect(metadata.ipAddress).toHaveLength(45);
    expect(metadata.userAgent).toHaveLength(500);
    expect(metadata.deviceModel).toHaveLength(100);
    expect(metadata.osVersion).toHaveLength(30);
    expect(metadata.appVersion).toHaveLength(50);
    expect(metadata.platform).toBe('UNKNOWN');
  });
});
