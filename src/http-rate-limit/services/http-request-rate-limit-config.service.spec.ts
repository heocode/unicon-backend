import { ConfigService } from '@nestjs/config';

import { HttpRequestRateLimitConfigService } from './http-request-rate-limit-config.service';

const values = {
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST: 200,
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE: 600,
  HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS: 60,
};

function createConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const config = new ConfigService({ ...values, ...overrides });
  config.skipProcessEnv = true;
  return config;
}

describe('HttpRequestRateLimitConfigService', () => {
  it('captures policy inputs once and preserves fractional rate inputs', () => {
    const config = createConfig();
    const service = new HttpRequestRateLimitConfigService(config);

    expect(service.publicPasswordless).toEqual({
      burst: 200,
      rate: 600,
      periodSeconds: 60,
    });
    expect(Object.isFrozen(service.publicPasswordless)).toBe(true);
    config.set('HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE', 999);
    expect(service.publicPasswordless.rate).toBe(600);
    expect(Reflect.set(service.publicPasswordless, 'rate', 999)).toBe(false);
  });

  it('uses tuned settings without substituting hardcoded V1 defaults', () => {
    const overrides: Record<string, number> = {
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST: 101,
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE: 102,
      HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS: 103,
    };
    const service = new HttpRequestRateLimitConfigService(
      createConfig(overrides),
    );

    expect(service.publicPasswordless).toEqual({
      burst: overrides.HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST,
      rate: overrides.HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE,
      periodSeconds: overrides.HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS,
    });
  });

  it.each(Object.keys(values))(
    'fails if required setting %s is missing',
    (key) => {
      expect(
        () =>
          new HttpRequestRateLimitConfigService(
            createConfig({ [key]: undefined }),
          ),
      ).toThrow(key);
    },
  );
});
