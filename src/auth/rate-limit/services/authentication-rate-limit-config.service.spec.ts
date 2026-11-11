import { ConfigService } from '@nestjs/config';

import { AuthenticationRateLimitConfigService } from './authentication-rate-limit-config.service';

const values = {
  AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS: 60,
  AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS: 60,
  AUTH_DELIVERY_IDENTITY_BURST: 10,
  AUTH_DELIVERY_IDENTITY_RATE: 7,
  AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS: 3600,
  AUTH_DELIVERY_IP_BURST: 120,
  AUTH_DELIVERY_IP_RATE: 240,
  AUTH_DELIVERY_IP_PERIOD_SECONDS: 3600,
  AUTH_VERIFICATION_IDENTITY_SHORT_BURST: 6,
  AUTH_VERIFICATION_IDENTITY_SHORT_RATE: 6,
  AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS: 60,
  AUTH_VERIFICATION_IP_SHORT_BURST: 72,
  AUTH_VERIFICATION_IP_SHORT_RATE: 72,
  AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS: 60,
  AUTH_VERIFICATION_IDENTITY_LONG_BURST: 8,
  AUTH_VERIFICATION_IDENTITY_LONG_RATE: 12,
  AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS: 3600,
  AUTH_VERIFICATION_IP_LONG_BURST: 360,
  AUTH_VERIFICATION_IP_LONG_RATE: 360,
  AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS: 3600,
};

function createConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const config = new ConfigService({ ...values, ...overrides });
  config.skipProcessEnv = true;
  return config;
}

describe('AuthenticationRateLimitConfigService', () => {
  it('captures policy inputs once and preserves fractional rate inputs', () => {
    const config = createConfig();
    const service = new AuthenticationRateLimitConfigService(config);
    expect(service.challengeDeliveryCooldownSeconds).toBe(60);
    expect(service.identityDeliveryCooldownSeconds).toBe(60);
    expect(service.deliveryIdentity).toEqual({
      burst: 10,
      rate: 7,
      periodSeconds: 3600,
    });
    expect(Object.isFrozen(service.deliveryIdentity)).toBe(true);
    expect(service.deliveryIp).toEqual({
      burst: 120,
      rate: 240,
      periodSeconds: 3600,
    });
    expect(Object.isFrozen(service.deliveryIp)).toBe(true);
    expect(service.verificationIdentityShortTerm).toEqual({
      burst: 6,
      rate: 6,
      periodSeconds: 60,
    });
    expect(Object.isFrozen(service.verificationIdentityShortTerm)).toBe(true);
    expect(service.verificationIpShortTerm).toEqual({
      burst: 72,
      rate: 72,
      periodSeconds: 60,
    });
    expect(Object.isFrozen(service.verificationIpShortTerm)).toBe(true);
    expect(service.verificationIdentityLongTerm).toEqual({
      burst: 8,
      rate: 12,
      periodSeconds: 3600,
    });
    expect(Object.isFrozen(service.verificationIdentityLongTerm)).toBe(true);
    expect(service.verificationIpLongTerm).toEqual({
      burst: 360,
      rate: 360,
      periodSeconds: 3600,
    });
    expect(Object.isFrozen(service.verificationIpLongTerm)).toBe(true);
    config.set('AUTH_DELIVERY_IDENTITY_RATE', 999);
    expect(service.deliveryIdentity.rate).toBe(7);
    expect(Reflect.set(service.deliveryIdentity, 'rate', 999)).toBe(false);
  });

  it('uses tuned settings without substituting hardcoded V1 defaults', () => {
    const overrides: Record<string, number> = {
      AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS: 101,
      AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS: 102,
      AUTH_DELIVERY_IDENTITY_BURST: 103,
      AUTH_DELIVERY_IDENTITY_RATE: 104,
      AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS: 105,
      AUTH_DELIVERY_IP_BURST: 106,
      AUTH_DELIVERY_IP_RATE: 107,
      AUTH_DELIVERY_IP_PERIOD_SECONDS: 108,
      AUTH_VERIFICATION_IDENTITY_SHORT_BURST: 109,
      AUTH_VERIFICATION_IDENTITY_SHORT_RATE: 110,
      AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS: 111,
      AUTH_VERIFICATION_IP_SHORT_BURST: 112,
      AUTH_VERIFICATION_IP_SHORT_RATE: 113,
      AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS: 114,
      AUTH_VERIFICATION_IDENTITY_LONG_BURST: 115,
      AUTH_VERIFICATION_IDENTITY_LONG_RATE: 116,
      AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS: 117,
      AUTH_VERIFICATION_IP_LONG_BURST: 118,
      AUTH_VERIFICATION_IP_LONG_RATE: 119,
      AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS: 120,
    };
    const service = new AuthenticationRateLimitConfigService(
      createConfig(overrides),
    );
    expect(service.challengeDeliveryCooldownSeconds).toBe(
      overrides.AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS,
    );
    expect(service.identityDeliveryCooldownSeconds).toBe(
      overrides.AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS,
    );
    expect(service.deliveryIdentity).toEqual({
      burst: overrides.AUTH_DELIVERY_IDENTITY_BURST,
      rate: overrides.AUTH_DELIVERY_IDENTITY_RATE,
      periodSeconds: overrides.AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS,
    });
    expect(service.deliveryIp).toEqual({
      burst: overrides.AUTH_DELIVERY_IP_BURST,
      rate: overrides.AUTH_DELIVERY_IP_RATE,
      periodSeconds: overrides.AUTH_DELIVERY_IP_PERIOD_SECONDS,
    });
    expect(service.verificationIdentityShortTerm).toEqual({
      burst: overrides.AUTH_VERIFICATION_IDENTITY_SHORT_BURST,
      rate: overrides.AUTH_VERIFICATION_IDENTITY_SHORT_RATE,
      periodSeconds: overrides.AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS,
    });
    expect(service.verificationIpShortTerm).toEqual({
      burst: overrides.AUTH_VERIFICATION_IP_SHORT_BURST,
      rate: overrides.AUTH_VERIFICATION_IP_SHORT_RATE,
      periodSeconds: overrides.AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS,
    });
    expect(service.verificationIdentityLongTerm).toEqual({
      burst: overrides.AUTH_VERIFICATION_IDENTITY_LONG_BURST,
      rate: overrides.AUTH_VERIFICATION_IDENTITY_LONG_RATE,
      periodSeconds: overrides.AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS,
    });
    expect(service.verificationIpLongTerm).toEqual({
      burst: overrides.AUTH_VERIFICATION_IP_LONG_BURST,
      rate: overrides.AUTH_VERIFICATION_IP_LONG_RATE,
      periodSeconds: overrides.AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS,
    });
  });

  it.each(Object.keys(values))(
    'fails if required setting %s is missing',
    (key) => {
      expect(
        () =>
          new AuthenticationRateLimitConfigService(
            createConfig({ [key]: undefined }),
          ),
      ).toThrow(key);
    },
  );
});
