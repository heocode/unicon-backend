import { ConfigService } from '@nestjs/config';

import { GcraAdmissionConfigService } from './gcra-admission-config.service';

const values = {
  RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS: 3,
  RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS: 5,
  RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS: 2,
};

describe('GcraAdmissionConfigService', () => {
  it('snapshots validated transaction bounds', () => {
    const config = new ConfigService(values);
    const service = new GcraAdmissionConfigService(config);
    config.set('RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS', 1);
    expect(service.maxAttempts).toBe(3);
    expect(service.timeoutSeconds).toBe(5);
    expect(service.maxWaitSeconds).toBe(2);
  });

  it.each(Object.keys(values))('requires %s', (key) => {
    const config = new ConfigService({ ...values, [key]: undefined });
    config.skipProcessEnv = true;
    expect(() => new GcraAdmissionConfigService(config)).toThrow(key);
  });
});
