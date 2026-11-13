# Stage 4 / Iteration 6 integration verification

Status: **COMPLETE (internal Stage 4 / Iteration 6 scope)**. Scope: internal admission and delivery integration;
public passwordless HTTP endpoints remain Stage 5–6 work.

## Evidence and scenario matrix

The PostgreSQL suites execute real repositories, encryption, admission, workers
and mail transport. The local HTTP provider is selected by overriding only the
HTTP client's destination; it is not a replacement for a database-backed service.
Two independent Nest/Prisma instances exercise cross-replica state. Tests that
construct historical/expired records label those fixtures explicitly. They do
not change runtime policies or substitute a frozen clock.

| Scenario | Required result | Evidence |
| --- | --- | --- |
| Admitted auth and notification compete across replicas | Both use the shared gate; no second admission charge; proof remains unchanged | `notification-mail-queue.e2e-spec.ts`: “integrates admitted auth and notification sends across replicas without recharging admission” |
| Auth receives provider Retry-After | Notification waits with zero attempts; auth retains its backoff; both recover after actual DB eligibility with the original keys/content | Same suite: “auth-imposed Retry-After stops both queues and timed recovery preserves proof, keys and admission debt” |
| Monthly provider pause and obsolete work | Auth cancels and expired notification fails without HTTP or charged attempts; retention cleanup progresses; active cooldown/rate debt and operation receipts remain | Same suite: “terminalization and cleanup progress for both queues during monthly pause without erasing active debt” |
| Shared gate state is unavailable | Both queues fail closed, retain work and charge no processing attempts; controlled state repair permits recovery | Same suite: “both queues fail closed on shared gate infrastructure loss and resume without losing or recharging work” |
| Retention expires while provider HTTP is in flight | Even a future retention cutoff cannot revoke a DB-active lease; known acceptance is recorded; terminal retention cleanup then succeeds without altering gate state | Same suite: “cleanup preserves an in-flight leased notification until its known acceptance is recorded” |
| Permission spacing / no idle burst | PostgreSQL decision times follow the configured GCRA policy across clients; no reserved future slots or refunded permissions | `mail-submission-gate.e2e-spec.ts` |
| Cross-message pressure and quota classification | No shortening of shared Retry-After; daily UTC and revision-checked monthly recovery; failures remain technical | `mail-provider-pressure.e2e-spec.ts` |
| Lease recovery and ambiguous HTTP | Charged history, immutable payload/key and five-attempt budget survive recovery; stale owners cannot mutate successors | `authentication-worker-mail-gate.e2e-spec.ts`, `notification-mail-queue.e2e-spec.ts` |
| Admission/backlog boundary | Atomic admission, denial immutability, existing-work resolution and strict unfinished auth backlog remain independent of provider capacity | `authentication-delivery-backlog.e2e-spec.ts`, `authentication-global-delivery-admission.e2e-spec.ts`, `authentication-admission-lifecycle.e2e-spec.ts` |
| Snapshot security | Versioned AEAD binds content to the job; unknown retained key defers; corrupt content and invalidated legacy proof never submit | Mail encryption unit suite and `notification-mail-queue.e2e-spec.ts` |

## Send-path audit

Runtime search found one provider URL: `ResendMailHttpClient`. Its send method is
called by `ResendMailTransportService`, which acquires the shared gate before
HTTP. The raw HTTP client is private to MailModule; no application SDK send
calls or alternate provider URLs remain in src/scripts. The deprecated raw auth
transport and the separate account-completion retry/dispatch path are removed.

- Passwordless initial/resend/retry: auth provider adapter -> common transport.
  Existing AuthenticationChallengeDelivery owns lifecycle and retries.
- Legacy verification, new-session/suspicious alerts, password-change/reset and
  account-deletion mail: MailService -> encrypted NotificationDelivery snapshot
  -> MailDeliveryWorkerService -> common transport. All nine MailService paths
  enqueue instead of declaring provider success.
- Notification work does not acquire auth creation/identity/IP Delivery budgets.
  Auth work is never inserted into the notification queue.

This is an audit of registered current callers, not an automatic guarantee that
future source changes cannot introduce a bypass. New senders must use this same
boundary and retain independent scenario admission rules.

## Narrow correction found by the integration check

The held-HTTP test reproduced an active-lease deletion with the old cleanup:
a future retention cutoff returned one deleted row while the real provider
request was still awaiting its response. Cleanup previously used that same
caller-supplied Date both as retention cutoff and as lease time authority.
NotificationDeliveryService now binds the requested retention cutoff but checks
lease expiration against PostgreSQL clock_timestamp() in the DELETE statement.
The regression must return zero until lease release, record the known accepted
result, then delete the terminal retained row. This is a lease-guard correction;
it changes no schema, retry budget, queue or provider policy.

## Verification environment and limits

Use a dedicated PostgreSQL database with a name ending in `_test`, explicit
TEST_DATABASE_URL and DOTENV_CONFIG_PATH=/dev/null. Suites importing AppModule
run from a temporary working directory without .env, with only assets and Prisma
migration paths linked from the repository. Provider requests go to local HTTP;
HTTP account/session/recovery tests assert persisted enqueue, with background
sending disabled and actual sending covered by the separate worker suites.

Run time-sensitive PostgreSQL suites without concurrent compilation/type scans.
Use database time for deadline/eligibility fixtures and a new dedicated database
after an interrupted or failed concurrency run, so late commits cannot become
another suite's queue candidates. This does not reset live limiter state or
weaken any production transaction/lease policy.

Final closure results (2026-11-13):

- build and lint --no-fix pass;
- 1085 unit tests pass across 88 suites;
- 456 e2e tests pass across 24 suites, including the five new integration cases;
- Prisma validate passes; 39 migrations are current on
  unicon_iteration6_closure_test;
- the separate full TypeScript scan reports the same 67 pre-existing diagnostics
  and no diagnostic in the changed integration suite; repository-wide tsc is
  not claimed clean.

The first full regression run observed one unexpected 404 in the existing
session-limit HTTP test. The isolated test and subsequent full run passed;
no auth/session logic or assertion was relaxed and the transient's cause is not
established by these results. Retain that observation for broader stability work.

No primary database, real provider send, .env secret, commit or deployment is
part of this block.

## Rollout prerequisites and remaining work

Before deployment, configure the required independent mail encryption keyring and
mail worker settings documented in .env.example. Retain old key versions while
pending/restorable jobs use them. Stop/drain old application delivery workers and
account finalizers, apply the additive migrations, and restart one compatible
version across replicas. Do not mix the old synchronous notification writers
with the queued lifecycle. Review historical unsnapshotted pending/failed
notifications explicitly; runtime does not invent or replay their content.

Iteration 7 retains sustained/burst load measurements, operational metrics,
privacy-safe attribution, tuning of preliminary admission/backlog limits, wider
configuration/rotation scenarios and real process/network/commit-ack fault
injection. Live Resend/mailbox validation requires a separately authorized,
bounded run. Existing response/persistence crash gaps and network-arrival timing
are not claimed solved by local provider tests. Stage 5–6 completes public HTTP
validation/guard/error mapping and full request-to-session coverage.
