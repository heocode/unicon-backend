import { validateEnvironment } from './environment.validation';

const validEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/unicon',
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'refresh-secret',
  JWT_REFRESH_EXPIRES_IN: '7d',
  RESEND_API_KEY: 'resend-api-key',
  MAIL_FROM: 'noreply@unicon.local',
  CLIENT_URL: 'http://localhost:3001',
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

  it('rejects an expiration without a duration unit', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_ACCESS_EXPIRES_IN: '900',
      }),
    ).toThrow('Environment variable JWT_ACCESS_EXPIRES_IN must be a duration');
  });
});
