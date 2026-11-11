// NestJS
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Internal types
import type { GcraPolicyConfig } from '../../../common/types/gcra-policy-config.type';

@Injectable()
export class AuthenticationRateLimitConfigService {
  readonly challengeDeliveryCooldownSeconds: number;
  readonly identityDeliveryCooldownSeconds: number;
  readonly deliveryIdentity: GcraPolicyConfig;
  readonly deliveryIp: GcraPolicyConfig;
  readonly verificationIdentityShortTerm: GcraPolicyConfig;
  readonly verificationIpShortTerm: GcraPolicyConfig;
  readonly verificationIdentityLongTerm: GcraPolicyConfig;
  readonly verificationIpLongTerm: GcraPolicyConfig;

  constructor(configService: ConfigService) {
    this.challengeDeliveryCooldownSeconds = configService.getOrThrow<number>(
      'AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS',
    );
    this.identityDeliveryCooldownSeconds = configService.getOrThrow<number>(
      'AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS',
    );
    this.deliveryIdentity = Object.freeze({
      burst: configService.getOrThrow<number>('AUTH_DELIVERY_IDENTITY_BURST'),
      rate: configService.getOrThrow<number>('AUTH_DELIVERY_IDENTITY_RATE'),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS',
      ),
    });
    this.deliveryIp = Object.freeze({
      burst: configService.getOrThrow<number>('AUTH_DELIVERY_IP_BURST'),
      rate: configService.getOrThrow<number>('AUTH_DELIVERY_IP_RATE'),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_DELIVERY_IP_PERIOD_SECONDS',
      ),
    });
    this.verificationIdentityShortTerm = Object.freeze({
      burst: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_SHORT_BURST',
      ),
      rate: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_SHORT_RATE',
      ),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS',
      ),
    });
    this.verificationIpShortTerm = Object.freeze({
      burst: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IP_SHORT_BURST',
      ),
      rate: configService.getOrThrow<number>('AUTH_VERIFICATION_IP_SHORT_RATE'),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS',
      ),
    });
    this.verificationIdentityLongTerm = Object.freeze({
      burst: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_LONG_BURST',
      ),
      rate: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_LONG_RATE',
      ),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS',
      ),
    });
    this.verificationIpLongTerm = Object.freeze({
      burst: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IP_LONG_BURST',
      ),
      rate: configService.getOrThrow<number>('AUTH_VERIFICATION_IP_LONG_RATE'),
      periodSeconds: configService.getOrThrow<number>(
        'AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS',
      ),
    });
  }
}
