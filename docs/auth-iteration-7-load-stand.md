# Stage 4 / Iteration 7: internal load stand

## Block 1 boundary

The first block is a bounded local instrumentation smoke, not a capacity test or
production tuning result. It exercises the real `AuthenticationOperationService`
through PostgreSQL admission, encrypted challenge proof, the scheduled auth
delivery worker, shared provider gate, common transport and HTTP client. Only
the HTTP destination is replaced with a loopback fake provider. There are no
database/service mocks and no production runtime changes.

The input boundary is an internal sign-in operation after email/domain eligibility
validation, not a public HTTP endpoint. Synthetic identities use
`load.example.edu`; institutional-domain HTTP validation is outside this block.
No User or Session is created. Stage 5–6 will complete public HTTP measurements.

## Run

Start the existing `unicon-postgres-test` PostgreSQL container on port 5433, then:

```bash
npm run test:load:smoke
```

The launcher creates/migrates only `unicon_load_test`, using the local test role
`unicon_e2e`. Its URL defaults to the existing public local-test credentials.
An explicit `TEST_DATABASE_URL` must still identify that exact database and role
on localhost/127.0.0.1 port 5433, without URL query parameters. It rejects other
targets. It never loads repository `.env`, strips inherited application settings
and secrets, and runs Jest from a temporary working directory. Public test defaults
come from `test/setup-env.ts`; `test/load/setup.ts` explicitly fixes experimental
global admission at burst 100, rate 120/60 seconds, backlog 1000. These are not
approved production thresholds. The send gate remains 8/second, team ceiling 10.

The default scenario offers six distinct identities at two operations/second,
with a 25 ms fake-provider response delay. The first arrival is at time zero;
the last of N scheduled arrivals is at `(N - 1) / rate`, followed by drain.

For another small smoke:

```bash
LOAD_RATE=4 LOAD_DURATION_SECONDS=3 LOAD_PROVIDER_DELAY_MS=100 npm run test:load:smoke
```

Supported integer bounds: `LOAD_RATE` 1–20, `LOAD_DURATION_SECONDS` 1–10,
at most 100 arrivals, `LOAD_PROVIDER_DELAY_MS` 1–2000, `LOAD_DRAIN_SECONDS` 1–60
(default 15). Heavy/fault workloads are intentionally deferred.

Only the actual auth worker scheduler is started. The stand does not initialize
the entire app or run unrelated cleanup/notification schedulers. An advisory lock
prevents cooperating stand launches from running together. Do not run other
applications/tests against this dedicated database concurrently. A preflight
rejects unfinished auth or notification work before starting the worker.

Data and active rate/cooldown/provider-pressure state are retained across runs;
the command never resets counters, refunds debt, deletes queued jobs or drops
the database. Repeated runs can therefore encounter real retained restrictions.
On interrupted/failed runs inspect unfinished work before choosing a separate
recovery/fixture-maintenance action. No automatic destructive recovery is built in.

## Measurements and assertions

The ignored `load-results/smoke-<timestamp>.json` artifact contains:

- scenario, run ID, source HEAD, runtime settings from an explicit non-secret
  allowlist, Node/PostgreSQL versions and host resource information;
- configured arrival rate/count, actual launch span and scheduling lag;
- operation outcomes/denial reasons and safe infrastructure-error categories;
- nearest-rank p50/p95/p99/max with sample counts for operation latency, actual
  HTTP-client duration and operation-entry to fake-provider response emission;
- provider request count, terminal delivery states and observed completion rate
  across the whole run including drain (not sustainable throughput);
- sampled outstanding queue count/oldest age every approximately 100 ms, sampled
  peak and final outstanding count; a sampled peak can miss shorter spikes;
- checks for accounting, generator pacing, no operation errors, at least one
  created Delivery, all created Deliveries SENT, exactly one processing attempt
  each, and matching unique provider submissions/response samples.

Operation timing includes operation-ID creation and database work. The terminal
SENT state is checked separately from the provider's response emission timestamp.
The scheduling-lag check fails if any arrival is at least one configured arrival
interval late; this is a smoke-generator validity check, not a user latency SLO.
Requests are launched without awaiting earlier operations, and failures receive
handlers immediately. Fixed arrivals and truthful failure accounting avoid
silently reducing load when the system slows.

Reports contain no connection URLs, credentials, emails, IPs, challenge IDs,
idempotency keys, request bodies or plaintext proof. The fake provider drains and
discards request bodies, retaining only transient idempotency correlation in memory.
The test never contacts live Resend. Small sample percentiles are descriptive;
they cannot establish p99 SLO compliance. Host CPU/RAM are not Docker limits.
The generator and fake provider share the application process in this first
local block, so no production capacity conclusion is valid.

Worker/gate waits are not separately instrumented yet. Metrics export failures,
multi-process competition, fault injection and configuration/key rotation remain
later Iteration 7 work. JSON-output failure fails the stand without changing the
production enforcement path. The report identifies HEAD and worktree dirtiness; uncommitted stand
changes must be reviewed alongside that commit.

## Block 1 verification

Verified locally on 2026-11-13, based on HEAD `5f3c4d2` plus this uncommitted
block. The dedicated stand database was created and all 39 existing migrations
were deployed. No schema changes were required.

| Scenario | Offered / created / SENT | Sampled peak backlog / final | Maximum scheduling lag | Operation-to-provider-response p95/p99 |
| --- | --- | --- | --- | --- |
| 2/s, six arrivals, 25 ms provider delay | 6 / 6 / 6 | 2 / 0 | 1.10 ms | 1113 ms |
| Repeat, retained limiter state | 6 / 6 / 6 | 2 / 0 | 1.40 ms | 1110 ms |
| 4/s, twelve arrivals, 100 ms provider delay | 12 / 12 / 12 | 5 / 0 | 1.46 ms | 1303 ms |

All had zero admission errors/denials and exactly one processing attempt and one
HTTP submission per created Delivery. The final configurable smoke and the three
measurement-helper tests passed. The helper scenarios verify bounded inputs,
empty/nearest-rank percentile reporting, independent arrivals and failure
accounting. An explicit attempt to target another database was rejected before
connection/preparation. These tiny samples do not establish the subsecond p99
objective; they demonstrate that the stand records the observed waiting honestly.

Regression checks: build, lint without fixes, 1085 unit tests in 88 suites,
456 existing e2e tests in 24 suites, Prisma validate, migrate status and
`git diff --check` passed. Full e2e ran separately against
`unicon_iteration6_closure_test` from a temporary directory without repository
`.env` loading. Prisma status is current on `unicon_load_test`; no statement is
made about the primary database. Full `tsc --noEmit` still reports the same 67
pre-existing test diagnostics; none are in the added stand files. It is not a
globally clean TypeScript check.

Raw local artifacts (ignored by Git): `load-results/smoke-1794597634778.json`,
`load-results/smoke-1794597748663.json`, `load-results/smoke-1794597892364.json`.
The final artifact also records worktree dirtiness and generator pacing validity.

## Iteration 7 sequence

1. Bounded local stand and measurement smoke (this block).
2. Multi-process concurrency/correctness, policy attribution, denial immutability,
   rollback, cleanup and safe configuration/key rotation; add the operational
   measurements and failure-isolation checks needed by those scenarios.
3. Local overload, sustained/spike traffic and controlled provider/process/network
   faults, including uncertain commit reconciliation with real PostgreSQL.
4. Separately provision the chosen target-platform test deployment and resources,
   with a generator outside the measured application.
5. Repeat load scenarios there to measure sustainable capacity and recovery.
6. Select preliminary global rate/burst/backlog and worker settings with headroom,
   repeat verification and record remaining rollout requirements.

Each block is reviewed separately. Real Resend/mailbox checks require separately
agreed bounded sending; bulk traffic always uses the fake provider. Public
HTTP end-to-end tests remain Stage 5–6 work. A provider-pressure response/persist
crash gap is not implicitly solved by this stand; any design correction needs its
own concrete explanation and agreement.

## Block 2.1: independent OS processes

Run the bounded concurrency scenarios with:

```bash
npm run test:load:concurrency
```

It uses the same guarded `unicon_load_test`, sanitized environment and exclusive
stand lock as the smoke command. The launcher compiles only the test replica and
its imported source dependencies into a temporary directory before starting Jest.
Production `dist` files are not used or modified by this command. No additional
public HTTP endpoint or application configuration is introduced.

The observer starts two Node.js children with separate Nest service graphs and
Prisma clients. Readiness includes distinct OS PIDs and matching configuration.
Each child prepares four independent operation IDs. After both acknowledge that
preparation is complete, the observer releases both batches over IPC. Real
admission transactions execute concurrently; workers start only after admission
results have been checked, preserving unfinished-work resolution during the race.

The three scenarios are:

| Scenario | Concurrent operations | Expected database result before workers |
| --- | --- | --- |
| Independent identities/IPs | Eight, four per process | Eight challenges and eight INITIAL Deliveries |
| Same identity INITIAL | Eight, four per process | One challenge, one INITIAL Delivery; seven REUSED receipts |
| Same challenge RESEND | Eight, four per process | One new RESEND Delivery; seven EXISTING receipts |

Each phase starts a fresh pair (six child launches, at most two active together).
Both real worker schedulers compete for the same queue. A manual first `runOnce`
kicks the real worker cycle; later capacity wakes and interval cycles use its
unchanged scheduling. For the independent-identity phase both workers must claim
work; the test does not require equal shares or guarantee fairness.

After the same-identity INITIAL is SENT, its workers are shut down. The observer
waits until both persisted challenge/identity cooldown boundaries have actually
passed according to PostgreSQL time. The 60-second settings and all existing
debt remain intact. The following RESEND race uses a fresh pair so workers cannot
finish the new Delivery before competing requests resolve it. Expect the complete
command to take over a minute, including real cooldown waiting and compilation.

The observer verifies actual receipts, challenge/Delivery counts, zero attempts
before workers, SENT/one attempt afterwards, and one HTTP submission per new
Delivery. It independently reconstructs GCRA TAT as
`max(previous TAT, committed admission time) + period/rate`, using exact bigint
fractions and actual receipt timestamps for global/identity/IP buckets. Cooldown
boundaries must match committed admission time plus their configured intervals.
Worker execution must leave admission debt and cooldown rows unchanged.

Only the HTTP destination is substituted. The real shared gate method is wrapped
for observation: it is always called unchanged, and its committed GRANTED times
and future boundaries are collected transiently. Combined grants from both
processes must respect the shared 125 ms spacing at eight permissions/second and
match the final persisted gate TAT. HTTP arrival spacing itself is not treated as
the authoritative grant interval.

The challenge's proof hashes, encrypted envelope, protocol/key versions, fixed
expiration, failed-attempt count and consumption/lock state are compared before
and after processing and resend. Fake-provider payload digests are compared in
memory to establish identical content across INITIAL/RESEND. No raw body, proof,
digest, recipient, idempotency key, operation/challenge ID or bucket key is written
to the JSON report. IPC carries only internal test requests/results and committed
gate observations; child stdout/stderr are discarded.

`load-results/concurrency-<timestamp>.json` records per-process outcome counts,
operation latency, real PIDs, selected configuration, worker claims, provider-call
counts by process, grant/deferral counts, invariant checks and overall status.
Operation latency is measured inside the child around `execute`, after operation
IDs have been prepared; it excludes ID preparation and IPC. It is not directly
the same timing boundary as block 1's operation-entry measurement.
Admission errors or missing child responses fail the scenario; there are no
test-level retries or refunds. IPC responses and drain/shutdown waits are bounded;
an unresponsive child is terminated during teardown. Failure can leave retained
unfinished work, which must be inspected before another run. The launcher never
deletes it or resets enforcement state.

This is still an internal, small local concurrency check. It does not measure
sustainable capacity, public HTTP behavior, real mailbox arrival, notifications,
rotation/configuration rollout, cleanup, process/network faults or commit
ambiguity. Those remain their agreed later blocks.

### Block 2.1 observed results

Two complete local runs passed on 2026-11-13, based on HEAD `53716d5` plus this
block's worktree changes. Each ran 24 operations and sent ten Deliveries, with
no admission errors, repeated provider submissions or additional processing
attempts. Both initial/reuse and resend/existing results matched real receipts.

| Scenario (per run) | CREATED | REUSED / EXISTING | New Deliveries SENT | Shared gate grants |
| --- | --- | --- | --- | --- |
| Eight distinct identities | 8 | 0 | 8 | 8 |
| Eight INITIAL requests, one identity | 1 | 7 REUSED | 1 | 1 |
| Eight RESEND requests, one challenge | 1 | 7 EXISTING | 1 | 1 |

In the repeat, both workers initially claimed four jobs in the distinct-identity
phase and ultimately made four provider calls each. That split is an observation,
not a fairness guarantee. There were 28 capacity deferrals and eight granted
permissions in that phase; deferrals did not spend processing attempts. The
real DB-clock cooldown wait was approximately 59.7 seconds. Every receipt-based
GCRA/cooldown, grant-spacing, proof/envelope/lifetime and worker no-recharge check
passed. No debt or queue reset was performed between runs.

Ignored local artifacts: `load-results/concurrency-1794603045519.json` and
`load-results/concurrency-1794603234326.json`. The first run's cooldown `waitedMs`
also included the following phase; the final repeat records the actual wait
alone. Earlier bootstrap failures happened before admission and are not counted
as completed scenario runs.

Block 2.1 handoff checks passed: build, lint without fixes, the replica's scoped
TypeScript compilation, both complete concurrency runs, the previous smoke plus
three helper tests (four checks total), 1085 unit tests in 88 suites, 456 existing
e2e tests in 24 suites, Prisma validate/migrate status (39 migrations on the stand
database), launcher syntax and diff checks. Full e2e used the separate
`unicon_iteration6_closure_test` from an isolated temporary working directory.
The repository-wide TypeScript scan retains the 67 pre-existing diagnostics;
none are in the added files. No primary database, repository `.env`, live Resend,
production runtime or schema was changed.

## Block 2.2, first step: personal cooldown isolation

```bash
npm run test:load:identity-isolation
```

This is an additional explicit mode of the same guarded launcher and observer,
reusing the two compiled child processes, real services, receipt-based accounting
oracle and fake HTTP provider. Existing smoke/concurrency commands keep their
own scenarios. No application settings, runtime code or schema are changed.
The launcher fixes the mode in its sanitized environment; no inherited scenario
selection, application secrets or repository `.env` are used.

The seed phase races two INITIAL requests for one fresh active identity, obtaining
one CREATED and one REUSED receipt. Its real initial Delivery reaches SENT, and
the first pair of workers shuts down. A second pair then executes three successive
small concurrent waves while that challenge's real 60-second cooldown is active:

| Input in each wave | Expected result |
| --- | --- |
| Four INITIAL requests for the active identity | Four REUSED receipts, no new Delivery or admission charge |
| Four early RESEND requests for its live challenge | Four RATE_LIMITED receipts, each attributed to both challenge and identity cooldown |
| One INITIAL for a new independent identity on another IP | One CREATED receipt and one pending Delivery |

Both replicas receive two repeated INITIALs and two RESENDs in each wave. The
three independent requests use three fresh identities/IPs, with global capacity
available. They all go to the same replica in this bounded scenario; no load
balancing/fairness conclusion is inferred. Workers are paused until all waves
finish so denial/reuse semantics cannot be confused with processing completion.

Checks inspect real DB state after every wave:

- Nine committed receipts and matching process responses, including exactly four
  denials with both precise policy IDs and the original absolute retry boundary.
  Overlapping policies are counted separately: four denials have eight policy
  attributions; these are not eight denied operations.
- Exactly one new independent challenge/Delivery, still PENDING with zero
  processing attempts and no HTTP call before worker startup.
- Exact global/identity/IP GCRA and cooldown accounting from the one CREATED
  receipt; repeated INITIALs and denied RESENDs contribute no extra charge.
- Unchanged active-identity/IP debt, cooldown boundaries and updated timestamps,
  challenge/proof/lifetime/attempt state and existing Delivery records.

Both real workers then drain the three independent Deliveries. Each must reach
SENT with one processing attempt and one matching HTTP submission; exactly three
shared permissions are spent, without changing admission debt or cooldown state.
No policy is disabled and no clock, debt, cooldown or queued job is reset.

The JSON report records per-process outcomes, observed vs expected reuse/denial
counts, fixed policy attribution, independent-operation latency with sample count
and all invariant results. Operation timing excludes prepared IDs/IPC, as in 2.1.
No standalone normal-traffic baseline or latency-isolation SLO is asserted.
This tiny scenario does not establish that other users remain fast under an
arbitrary flood; it verifies that these personal cooldown denials do not reject
independent admissions while the tested shared capacity is available.

Two complete local runs passed on 2026-11-13, based on HEAD `69a0eab` plus the
current worktree. Each had 29 operations: seed (one CREATED, one REUSED), then
12 REUSED, 12 RATE_LIMITED and three independent CREATED outcomes across the
waves. Four Deliveries total reached SENT with one attempt each. The reports are
`load-results/identity-isolation-1794605104068.json` and
`load-results/identity-isolation-1794605131693.json` (ignored by Git).

The initial development run stopped on a cross-realm array-comparison issue
between child IPC responses and the observer's Jest context. Exact policy IDs
are now compared element by element; no domain assertion was removed. Its one
unfinished independent job was processed separately by the real worker against
the fake provider, preserving all rows and debt, before the complete reruns.
That failed run and its recovery are not counted as passed scenario coverage.

Shared-IP saturation, identity GCRA exhaustion, notification competition and heavy
traffic remain outside this first step. Block 2.2 is still IN PROGRESS.

Handoff checks passed: both complete identity-isolation runs; the unchanged 2.1
scenarios after shared batch extraction; original smoke and its three helper tests
(four checks); build; lint without fixes; 1085 unit tests/88 suites; 456 existing
e2e tests/24 suites; Prisma validate and migrate status (39 current migrations in
`unicon_load_test`); launcher syntax and diff checks. Full e2e used the separate
`unicon_iteration6_closure_test` with no repository `.env` loading. The full
TypeScript scan still has the same 67 pre-existing test diagnostics and none in
the changed files; the replica's scoped compilation passes. The primary database
and live Resend were not used.

Methodology references: [k6 open arrival models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/),
[repeatable performance testing](https://grafana.com/docs/k6/latest/testing-guides/automated-performance-testing/),
[Google SRE capacity testing](https://sre.google/sre-book/service-best-practices/).
