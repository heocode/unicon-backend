import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';
import type { RateLimitBucketPolicy } from './rate-limit-bucket-key.type';

/** Internal unit-cost admission input, never a client-selected policy. */
export type GcraAdmissionInput = Readonly<{
  policy: RateLimitBucketPolicy;
  settings: GcraPolicyConfig;
  characteristic: string | undefined;
}>;

/** Returned only after the owning transaction commits. */
export type GcraAdmissionResult =
  | Readonly<{ allowed: true; operationNowMicros: bigint }>
  | Readonly<{
      allowed: false;
      operationNowMicros: bigint;
      retryAfterSeconds: bigint;
    }>;

/** Provisional until commit when returned from consumeManyInTransaction. */
export type GcraMultiAdmissionResult =
  | Readonly<{ allowed: true; operationNowMicros: bigint }>
  | Readonly<{
      allowed: false;
      operationNowMicros: bigint;
      retryAfterSeconds: bigint;
      deniedPolicyIds: readonly string[];
    }>;
