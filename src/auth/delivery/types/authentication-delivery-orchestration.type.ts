export type AuthenticationDeliveryOrchestrationResult =
  | Readonly<{ outcome: 'SENT' }>
  | Readonly<{ outcome: 'RETRY_SCHEDULED' }>
  | Readonly<{ outcome: 'DEFERRED'; retryNotBeforeMicros?: bigint }>
  | Readonly<{ outcome: 'FAILED' }>
  | Readonly<{ outcome: 'CANCELLED' }>
  | Readonly<{ outcome: 'LEASE_LOST' }>;
