export type AuthenticationChallengeCleanupSummary = {
  clearedExpiredProofCount: number;
  deletedRetainedChallengeCount: number;
  executedBatchCount: number;
  reachedBatchLimit: boolean;
  skippedAlreadyRunning: boolean;
};
