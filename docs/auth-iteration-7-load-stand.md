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

Methodology references: [k6 open arrival models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/),
[repeatable performance testing](https://grafana.com/docs/k6/latest/testing-guides/automated-performance-testing/),
[Google SRE capacity testing](https://sre.google/sre-book/service-best-practices/).
