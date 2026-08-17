import {
  SECURITY_EVENT_SNAPSHOT_SELECT,
  toSecurityEventSnapshot,
} from './security-event-snapshot.util';

describe('security event snapshot utilities', () => {
  it('selects and maps the complete device snapshot', () => {
    expect(SECURITY_EVENT_SNAPSHOT_SELECT).toEqual({
      ipAddress: true,
      userAgent: true,
      deviceModelIdentifier: true,
      deviceModel: true,
      platform: true,
      osVersion: true,
      appVersion: true,
      locationCountryCode: true,
      locationCity: true,
    });

    expect(
      toSecurityEventSnapshot({
        ipAddress: '192.0.2.10',
        userAgent: 'Unicon/1.0',
        deviceModelIdentifier: 'iPhone17,1',
        deviceModel: 'iPhone 16 Pro',
        platform: 'IOS',
        osVersion: '18.6',
        appVersion: '1.4.2',
        locationCountryCode: 'CA',
        locationCity: 'Toronto',
      }),
    ).toEqual({
      ipAddress: '192.0.2.10',
      userAgent: 'Unicon/1.0',
      deviceModelIdentifier: 'iPhone17,1',
      deviceModel: 'iPhone 16 Pro',
      platform: 'IOS',
      osVersion: '18.6',
      appVersion: '1.4.2',
      locationCountryCode: 'CA',
      locationCity: 'Toronto',
    });
  });

  it('converts nullable Prisma snapshot fields to undefined', () => {
    expect(
      toSecurityEventSnapshot({
        deviceModelIdentifier: null,
        deviceModel: null,
        platform: null,
      }),
    ).toEqual({
      ipAddress: undefined,
      userAgent: undefined,
      deviceModelIdentifier: undefined,
      deviceModel: undefined,
      platform: undefined,
      osVersion: undefined,
      appVersion: undefined,
      locationCountryCode: undefined,
      locationCity: undefined,
    });
  });
});
