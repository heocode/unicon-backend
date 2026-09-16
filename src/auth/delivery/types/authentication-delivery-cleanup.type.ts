export type AuthenticationDeliveryCleanupSummary = Readonly<{
  deletedRetainedDeliveryCount: number;
  executedBatchCount: number;
  reachedBatchLimit: boolean;
  skippedAlreadyRunning: boolean;
}>;
