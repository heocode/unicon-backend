import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';

@Injectable()
export class MailSubmissionGateConfigService {
  readonly policy: GcraPolicyConfig;
  readonly teamRequestsPerSecond: number;

  constructor(config: ConfigService) {
    this.teamRequestsPerSecond = config.getOrThrow<number>(
      'MAIL_RESEND_TEAM_REQUESTS_PER_SECOND',
    );
    // Burst and period are fixed v1 semantics, not per-scenario configuration.
    this.policy = Object.freeze({
      burst: 1,
      rate: config.getOrThrow<number>('MAIL_RESEND_SUBMISSIONS_PER_SECOND'),
      periodSeconds: 1,
    });
  }
}
