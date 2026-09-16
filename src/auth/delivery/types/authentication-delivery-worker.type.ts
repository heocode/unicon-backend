export type AuthenticationDeliveryWorkerSummary = Readonly<{
  claimedCount: number;
  normalClaimCount: number;
  reclaimedClaimCount: number;
  sentCount: number;
  retryScheduledCount: number;
  failedCount: number;
  cancelledCount: number;
  leaseLostCount: number;
  unexpectedFailureCount: number;
  exhaustedLeaseCount: number;
  stoppedByClaimFailure: boolean;
  reachedCycleLimit: boolean;
  skippedAlreadyRunning: boolean;
}>;
