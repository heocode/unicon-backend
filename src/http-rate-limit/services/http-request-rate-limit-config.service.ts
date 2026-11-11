// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';

@Injectable()
export class HttpRequestRateLimitConfigService {
  // Shared only by the four public passwordless POST routes; no HTTP wiring yet.
  readonly publicPasswordless: GcraPolicyConfig;

  constructor(configService: ConfigService) {
    this.publicPasswordless = Object.freeze({
      burst: configService.getOrThrow<number>(
        'HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST',
      ),
      rate: configService.getOrThrow<number>(
        'HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE',
      ),
      periodSeconds: configService.getOrThrow<number>(
        'HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS',
      ),
    });
  }
}
