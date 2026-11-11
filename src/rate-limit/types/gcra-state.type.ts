import type { GcraPolicyConfig } from '../../common/types/gcra-policy-config.type';

/** Exact microseconds since Unix epoch; eligibility may precede the epoch. */
export type GcraTime = Readonly<{
  numerator: bigint;
  denominator: bigint;
}>;

export type GcraState = Readonly<{
  tat: GcraTime;
  policy: GcraPolicyConfig;
}>;

export type GcraEvaluation = Readonly<{
  allowed: boolean;
  eligibleAt: GcraTime;
  retryAfterSeconds: bigint;
}>;
