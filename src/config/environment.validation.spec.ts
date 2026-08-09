import { validateEnvironment } from './environment.validation';

const validEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/unicon',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_ACCESS_TTL_SECONDS: '900',
  JWT_REFRESH_SECRET: 'refresh-secret',
  SESSION_INACTIVITY_TTL_SECONDS: '31536000',
  SESSION_MANAGEMENT_COOLDOWN_SECONDS: '86400',
  SESSION_ACTIVE_LIMIT: '10',
  RESEND_API_KEY: 'resend-api-key',
  MAIL_FROM: 'noreply@unicon.local',
  CLIENT_URL: 'http://localhost:3001',
  GEOIP_ENABLED: 'false',
  GEOIP_DATABASE_PATH: 'data/geoip/GeoLite2-City.mmdb',
  GEOIP_RELOAD_INTERVAL_SECONDS: '60',
};

describe('validateEnvironment', () => {
  it('parses PORT and preserves validated configuration', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      PORT: '4000',
    });

    expect(environment.PORT).toBe(4000);
    expect(environment.DATABASE_URL).toBe(validEnvironment.DATABASE_URL);
  });

  it('uses port 3000 by default', () => {
    const environment = validateEnvironment(validEnvironment);

    expect(environment.PORT).toBe(3000);
  });

  it('rejects a missing required variable', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: undefined,
      }),
    ).toThrow('Environment variable DATABASE_URL is required.');
  });

  it('rejects a non-positive token TTL', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_ACCESS_TTL_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable JWT_ACCESS_TTL_SECONDS must be a positive integer.',
    );
  });

  it('rejects a non-positive session revoke cooldown', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_MANAGEMENT_COOLDOWN_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable SESSION_MANAGEMENT_COOLDOWN_SECONDS must be a positive integer.',
    );
  });

  it('rejects a non-positive active session limit', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SESSION_ACTIVE_LIMIT: '0',
      }),
    ).toThrow(
      'Environment variable SESSION_ACTIVE_LIMIT must be a positive integer.',
    );
  });

  it('parses the GeoIP enabled flag', () => {
    const environment = validateEnvironment({
      ...validEnvironment,
      GEOIP_ENABLED: 'true',
    });

    expect(environment.GEOIP_ENABLED).toBe(true);
  });

  it('rejects a non-positive GeoIP reload interval', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        GEOIP_RELOAD_INTERVAL_SECONDS: '0',
      }),
    ).toThrow(
      'Environment variable GEOIP_RELOAD_INTERVAL_SECONDS must be a positive integer.',
    );
  });
});
