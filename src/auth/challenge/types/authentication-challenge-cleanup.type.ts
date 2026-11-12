export type AuthenticationChallengeCleanupSummary = {
  clearedExpiredProofCount: number;
  deletedRetainedChallengeCount: number;
  deletedOrphanedSubjectCount: number;
  executedBatchCount: number;
  reachedBatchLimit: boolean;
  skippedAlreadyRunning: boolean;
};
