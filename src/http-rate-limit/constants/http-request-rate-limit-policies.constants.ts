import type { RateLimitBucketPolicy } from '../../rate-limit/types/rate-limit-bucket-key.type';

export const PUBLIC_PASSWORDLESS_REQUEST_POLICY = {
  id: 'HTTP_PUBLIC_PASSWORDLESS_REQUEST',
  characteristicKind: 'IP',
} as const satisfies RateLimitBucketPolicy;
