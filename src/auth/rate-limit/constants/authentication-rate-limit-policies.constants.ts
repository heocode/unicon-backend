import type { RateLimitBucketPolicy } from '../../../rate-limit/types/rate-limit-bucket-key.type';

export const AUTHENTICATION_RATE_LIMIT_POLICIES = {
  challengeDeliveryCooldown: {
    id: 'AUTH_CHALLENGE_DELIVERY_COOLDOWN',
    characteristicKind: 'CHALLENGE_ID',
  },
  identityDeliveryCooldown: {
    id: 'AUTH_IDENTITY_DELIVERY_COOLDOWN',
    characteristicKind: 'IDENTITY',
  },
  deliveryIdentity: {
    id: 'AUTH_DELIVERY_IDENTITY',
    characteristicKind: 'IDENTITY',
  },
  deliveryIp: {
    id: 'AUTH_DELIVERY_IP',
    characteristicKind: 'IP',
  },
  verificationIdentityShortTerm: {
    id: 'AUTH_VERIFICATION_IDENTITY_SHORT',
    characteristicKind: 'IDENTITY',
  },
  verificationIpShortTerm: {
    id: 'AUTH_VERIFICATION_IP_SHORT',
    characteristicKind: 'IP',
  },
  verificationIdentityLongTerm: {
    id: 'AUTH_VERIFICATION_IDENTITY_LONG',
    characteristicKind: 'IDENTITY',
  },
  verificationIpLongTerm: {
    id: 'AUTH_VERIFICATION_IP_LONG',
    characteristicKind: 'IP',
  },
} as const satisfies Record<string, RateLimitBucketPolicy>;
