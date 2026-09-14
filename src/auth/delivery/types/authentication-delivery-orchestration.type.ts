export type AuthenticationDeliveryOrchestrationResult =
  | Readonly<{ outcome: 'SENT' }>
  | Readonly<{ outcome: 'RETRY_SCHEDULED' }>
  | Readonly<{ outcome: 'FAILED' }>
  | Readonly<{ outcome: 'CANCELLED' }>
  | Readonly<{ outcome: 'LEASE_LOST' }>;
