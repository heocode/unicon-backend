export type RateLimitCharacteristicKind = 'IP' | 'IDENTITY' | 'CHALLENGE_ID';

export type RateLimitBucketPolicy = Readonly<{
  id: string;
  characteristicKind: RateLimitCharacteristicKind;
}>;

export type RateLimitBucketKey = Readonly<{
  keyVersion: number;
  key: string;
}>;

/** Every retained version must participate in authoritative enforcement. */
export type RateLimitBucketKeySet = Readonly<{
  protocolVersion: 1;
  activeKeyVersion: number;
  buckets: readonly RateLimitBucketKey[];
}>;
