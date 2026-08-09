import { normalizePublicIp } from './normalize-public-ip.util';

describe('normalizePublicIp', () => {
  it.each([
    ['8.8.8.8', '8.8.8.8'],
    [' 1.1.1.1 ', '1.1.1.1'],
    ['::ffff:8.8.8.8', '8.8.8.8'],
    ['2606:4700:4700::1111', '2606:4700:4700::1111'],
  ])('normalizes public address %s', (value, expected) => {
    expect(normalizePublicIp(value)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    'not-an-ip',
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
  ])('rejects non-public address %s', (value) => {
    expect(normalizePublicIp(value)).toBeNull();
  });
});
