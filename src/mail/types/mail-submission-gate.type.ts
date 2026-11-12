/** Returned only after the gate's own transaction commits. A permission is not
 * provider acceptance, a future reservation or an in-flight concurrency slot. */
export type MailSubmissionGateResult =
  | Readonly<{
      outcome: 'GRANTED';
      operationNowMicros: bigint;
      nextPermissionNotBeforeMicros: bigint;
    }>
  | Readonly<{
      outcome: 'DEFERRED';
      operationNowMicros: bigint;
      retryNotBeforeMicros: bigint;
    }>;
