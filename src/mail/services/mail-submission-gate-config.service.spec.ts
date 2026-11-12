import { ConfigService } from '@nestjs/config';

import { MailSubmissionGateConfigService } from './mail-submission-gate-config.service';

describe('MailSubmissionGateConfigService', () => {
  it('captures configured rate and ceiling with fixed one-permission burst/one-second period', () => {
    const config = new ConfigService({
      MAIL_RESEND_SUBMISSIONS_PER_SECOND: 8,
      MAIL_RESEND_TEAM_REQUESTS_PER_SECOND: 10,
    });
    const snapshot = new MailSubmissionGateConfigService(config);
    expect(snapshot.policy).toEqual({ burst: 1, rate: 8, periodSeconds: 1 });
    expect(snapshot.teamRequestsPerSecond).toBe(10);
    expect(Object.isFrozen(snapshot.policy)).toBe(true);
    config.set('MAIL_RESEND_SUBMISSIONS_PER_SECOND', 3);
    expect(snapshot.policy.rate).toBe(8);
    expect(Reflect.set(snapshot.policy, 'burst', 8)).toBe(false);
  });
  it('uses explicit tuning rather than hardcoding eight permissions', () => {
    const snapshot = new MailSubmissionGateConfigService(
      new ConfigService({
        MAIL_RESEND_SUBMISSIONS_PER_SECOND: 3,
        MAIL_RESEND_TEAM_REQUESTS_PER_SECOND: 4,
      }),
    );
    expect(snapshot.policy).toEqual({ burst: 1, rate: 3, periodSeconds: 1 });
    expect(snapshot.teamRequestsPerSecond).toBe(4);
  });
});
