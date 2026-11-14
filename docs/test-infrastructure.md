# Local test infrastructure

## Current boundary

The first infrastructure block introduced one guarded execution path for
ordinary e2e and the existing load scenarios. The second adds a migrated template
and one disposable copy per ordinary e2e invocation. The third extends that same
lifecycle to load scenarios, with isolated copies by default and explicit retained
state. Backups, automatic orphan sweeping and crash recovery remain outside scope.
Auth Stage 4 / Iteration 7 block 2.3 remains pending during this infrastructure work.

| Use | PostgreSQL target | Database |
| --- | --- | --- |
| E2e template | localhost:5433, role `unicon_e2e` | `unicon_e2e_template` |
| Ordinary e2e | Same instance and role | `unicon_e2e_<32 lowercase UUID hex digits>_test` |
| Load stand, default `isolated` | Same instance and role | `unicon_load_<32 lowercase UUID hex digits>_test` |
| Load stand, explicit `retained` | Same instance and role | `unicon_load_test` |

All targets belong to the dedicated Compose `postgres-test` service and volume.
The legacy `unicon-postgres` container on port 5432 belongs to the other workspace;
it is outside these launchers. The passwordless development service uses port
5434. Neither development nor legacy databases are test destinations.

The audit on 2026-11-13 found 17 user databases in the test container and two in
the legacy container, excluding PostgreSQL service/template databases. This
inventory was reviewed again on 2026-11-14. With explicit approval, 15 obsolete
test databases (about 151 MB) were deleted after checking ownership, connections
and row counts. The three persistent test databases are now the template,
`unicon_load_test` and `unicon_test` (healthcheck/connection selector). The legacy
container and all volumes were preserved. A post-cleanup e2e smoke passed and
the container remained healthy. Successful isolated e2e/load runs add no persistent
databases. Historical verification documents retain the names
of the databases actually used at the time; those names are no longer accepted
by the ordinary e2e launcher.

## Execution contract

`scripts/test-runtime.mjs` provides target validation, a bounded environment,
temporary working directories, PostgreSQL ownership/locking and subprocess
lifecycle handling. Entrypoints are `scripts/run-e2e.mjs`,
`scripts/prepare-e2e-database.mjs` and `scripts/run-auth-load-smoke.mjs`.

1. Validate the target before connecting. Only the fixed database for the chosen
   command, `unicon_e2e`, localhost/127.0.0.1 and port 5433 are accepted. Ordinary
   e2e still accepts only the original `unicon_test` URL as its connection
   selector, not as its runtime destination. The launcher derives template and
   temporary destinations itself; arbitrary run database URLs are not CLI inputs. Query
   parameters, fragments and missing passwords are rejected. URLs and passwords
   are not printed in launcher errors.
2. Create a temporary working directory with links to required assets and Prisma
   files. Do not copy `.env`. Migration/Jest subprocesses receive public test
   database settings, `PATH`, `TMPDIR`, test markers and `DOTENV_CONFIG_PATH=/dev/null`.
   Inherited JWT/mail keys, `PG*`, `NODE_OPTIONS` and other application settings
   are not forwarded. Load commands additionally forward only their four documented
   workload controls. Test defaults remain in `test/setup-env.ts`.
3. Connect to the local `postgres` admin database with explicit connection options
   and obtain a session advisory lock identified by a test namespace and target
   database name. A busy lock fails immediately. No creation/migration or fixture
   mutation occurs before locking. Isolated e2e/load lock the shared template
   for their full lifecycle; retained load locks `unicon_load_test` separately.
   Verify database ownership before migrations.
4. Hold that connection throughout migration, compilation where needed, Jest and
   replica execution. Ordinary e2e always runs serially because suites share
   fixture tables. Standalone preparation updates only the template and takes
   the same lock, but releases it when preparation ends; the full launcher is
   required to protect a test run. Isolated invocations remain serialized, even
   though each receives its own database. Retained load invocations serialize
   on their persistent target.
5. Preserve subprocess failure status. On SIGINT/SIGTERM or lock connection loss,
   abort the run and stop its own subprocess group, with a kill fallback. Isolated runs
   drops only its own verified temporary database while the lock is still held,
   then closes the lock connection and removes the invocation's temporary directory.
   No PostgreSQL backends
   are forcibly terminated; template, historical databases and volumes are preserved.

## Template and disposable database lifecycle

`scripts/test-database.mjs` implements the shared e2e/load lifecycle on top of
the runtime. The existing template name/marker remain unchanged. A missing
`unicon_e2e_template` is created from PostgreSQL
`template0`, marked as infrastructure-owned, and migrated with the real Prisma
CLI. An existing database with that name must have the expected owner and marker;
otherwise preparation stops without adopting or replacing it.

Before migration, successful migration records must match an unchanged ordered
prefix of the checkout's migration directories and SHA-256 SQL checksums. Foreign,
modified, failed, rolled-back or missing-history states stop the run. New migrations
are deployed automatically; afterward history must match the complete manifest.
Switching to an older/divergent branch therefore requires explicit template review,
not an automatic destructive rebuild.

Template tables must contain no test data. The current migrations install two
infrastructure rows: `AuthenticationDeliveryBacklogState` ID 1 and
`MailProviderPressure` ID 1 with zero pressure/revision and no monthly block.
These rows are preserved and checked; other application tables must be empty.
Development seeding is never run. If a future migration intentionally installs
other baseline data, the explicit purity check must be reviewed with that change.
This does not require hand-maintaining template SQL for ordinary schema migrations.
Direct manual schema changes are unsupported; migration history checks do not
constitute a complete schema-drift audit.

Template connections are enabled only under its lock for inspection/migration,
then disabled before cloning and Jest. All maintenance clients close before
`CREATE DATABASE ... TEMPLATE`. Test setup accepts only the generated database
name corresponding to `UNICON_TEST_RUN_ID`; it rejects the template and old fixed
database as e2e runtime destinations.

Before allocation, the launcher writes a non-secret ignored JSON record at
`.temp/e2e-runs/<UUID>.json` or `.temp/load-runs/<UUID>.json` with the kind, run ID,
database/template names, PID and
creation time. After creation it records the PostgreSQL OID via atomic file
replacement and marks the database with the same run ID. Cleanup uses the
invocation's generated name and verifies OID, owner and marker before dropping.
It briefly retries busy-database failures after its child processes stop, without
`DROP ... FORCE` or terminating unrelated sessions. Only successful cleanup removes
the run record. Loss of the lock connection, hard crashes, incomplete allocations
or ownership mismatches retain evidence for a later controlled recovery action.
No launcher scans and deletes historical or orphan databases.

## Load lifecycle modes

All five existing load commands accept one optional `--state=isolated|retained`.
Omitting the option selects `isolated`. The explicit `TEST_DATABASE_URL` selector
still identifies only `unicon_load_test` on the local test instance; it is not an
arbitrary runtime destination override.

```bash
npm run test:load:smoke
npm run test:load:concurrency -- --state=isolated
npm run test:load:mixed-mail -- --state=retained
```

An isolated run updates/verifies the shared template, clones a generated
`unicon_load_<UUID hex>_test`, then compiles replicas and starts Jest. All stages
and workers in that invocation share the same database. Data, cooldowns, GCRA
debt and provider pressure are never reset during the scenario. Its final JSON
report is saved outside the temporary directory before that invocation's copy
is deleted. Setup/migration/compilation/cleanup are outside scenario timing.
A fresh database does not reset PostgreSQL/OS caches or establish production capacity.

Retained mode prepares and locks the existing `unicon_load_test` and deliberately
keeps its data after success, failure or interruption. It does not allocate/drop
a database or write an allocation record. Each invocation still has a lifecycle
UUID for its report. The existing unfinished-work preflight remains mandatory;
this mode does not resume or erase work left by a crashed run automatically.
It is explicit continuation of state, not an orphan-recovery mechanism.

`test/utils/test-database-runtime.ts` is the test-only destination policy shared
by Jest setup, load observers and compiled replicas. It checks local role/endpoint,
run UUID, mode, exact expected database and equality of both database settings.
Two-process scenarios additionally compare the actual PostgreSQL database OID
and lifecycle metadata of each replica against the observer.

Reports now have `schemaVersion: 2` and `databaseLifecycle` with `runId`,
`stateMode` (`isolated`/`retained`) and `initialState` (`template`/`retained`).
The existing scenario `runId` remains independent. Reports do not include
connection URLs or credentials. Replica readiness includes the actual database
OID and matching lifecycle metadata. Existing measurements/assertions remain;
historical schema-version-1 artifacts keep their original meaning.

Advisory locks coordinate cooperating launchers. They do not prevent arbitrary
manual SQL clients from changing the target. Test fixture cleanup can delete
test data inside its own temporary database. Retained load keeps its existing
state; both load modes keep the unfinished-work preflight. There is no automatic recovery/reset.
SIGKILL, host crashes and PostgreSQL outages cannot guarantee graceful cleanup.

## Commands and verification

```bash
docker compose --profile test up -d postgres-test
npm run test:infra
npm run test:infra:db
npm run test:e2e -- --runInBand
npm run test:e2e -- --testPathPatterns=test-environment.e2e-spec
npm run test:load:smoke
```

The launcher tests use Node's built-in test runner. Pure tests cover rejected
targets, the three public CLI guards, inherited-setting removal, dotenv isolation
using a synthetic file, child failures, interruption and working-directory cleanup.
The PostgreSQL tests acquire real locks, reject competing preparation/full-run
entrypoints, and verify lock release after failure and interruption. These checks
do not substitute mocks for database locking. A Jest e2e test also asserts the
actual generated target, temporary cwd and public test credentials. Database-backed
lifecycle tests verify copy isolation, deletion after success/failure/interruption,
template connection protection, retained records on ownership mismatch, and refusal
of real changed/foreign/failed migration history or dirty template state.

## Block 1 verification (historical)

Verified locally on 2026-11-13 at HEAD `c2fc705` plus this uncommitted block:

| Check | Result |
| --- | --- |
| Launcher guards/environment/process lifecycle | 7 Node tests passed |
| Real PostgreSQL lock competition, failure and interruption | 2 Node tests passed |
| Application unit regression | 1085 tests, 88 suites passed |
| Canonical `unicon_test` e2e regression | 457 tests, 25 suites passed |
| Existing load smoke | 4 tests, 2 suites passed |
| Two-process concurrency/cooldown, identity isolation, shared IP, mixed queues | All four modes passed |
| Build; lint without fixes; changed code formatting; diff whitespace | Passed |
| Prisma validation and canonical test migration status | Valid; all 39 migrations applied |

Unit regression ran with the existing Jest configuration from an isolated
temporary cwd with dotenv disabled. Full e2e used the new launcher. No database
service was mocked in the locking or load checks. Load results confirm preserved
scenario assertions, not production capacity or production quota suitability.
Full `tsc --noEmit` still reports 67 pre-existing test diagnostics, with none in
the changed files; it is not a globally clean TypeScript check.

Ignored load artifacts from this verification:
`load-results/smoke-1794610221155.json`,
`load-results/concurrency-1794610226924.json`,
`load-results/identity-isolation-1794610293826.json`,
`load-results/shared-ip-1794610298964.json`,
`load-results/mixed-mail-1794610303649.json`.

## Block 2 verification

Verified locally on 2026-11-13–14 at HEAD `a612267` plus this uncommitted block:

| Check | Result |
| --- | --- |
| Pure launcher, destination and migration-history checks | 10 Node tests passed |
| Real PostgreSQL lock and disposable lifecycle checks | 6 Node tests passed |
| Application unit regression | 1085 tests, 88 suites passed |
| Final full e2e run in a generated database | 457 tests, 25 suites passed; 93.642 seconds |
| Load smoke on retained `unicon_load_test` | 4 tests, 2 suites passed |
| Build; lint without fixes; changed code formatting; diff whitespace | Passed |
| Prisma validation and migrate status in a generated copy | Valid; all 39 migrations applied |

The missing template was created and migrated automatically. Repeated preparation
reused it without rebuilding. Real copies verified migration history, empty user
data and isolation of a table inserted in the preceding copy. Tests also verified
cleanup after success, failed child exit and interruption; a changed ownership
marker prevented deletion and retained the record. The test then explicitly
removed only its own deliberately altered copy. Fault injection changed a real
template migration checksum, name or completion state, and separately changed
the provider-pressure singleton. Every case stopped before cloning; the test
restored the exact metadata/state it changed and verified preparation afterward.

Earlier regression attempts were not clean: the first full run passed 450/457
tests in 342.214 seconds, with transaction/timeout failures and subsequent
fixture-dependent failures. Focused repeats passed 111/112 and 55/79 tests;
one failure expected denial within a seeded 700 ms eligibility interval but
observed admission, while other failures included transaction bounds and
downstream queue assertions after earlier failures. These attempts are retained
as evidence of timing sensitivity, not discarded as successful checks.

The final full repeat used unchanged assertions, policy values and timeouts,
without parallel verification work and with idle sleep inhibited only for the
duration of that command (`caffeinate -i`). A small preceding diagnostic measured
simple PostgreSQL round trips at p50 1.04 ms, p95 2.02 ms, max 2.20 ms; it does
not establish the cause of earlier failures. All 457 tests then passed. No
production auth code was changed to obtain this result, and the earlier failure
cause is not conclusively isolated. After completion the temporary database was
dropped and `.temp/e2e-runs` was empty. Historical databases and load state remain
untouched by e2e. Only the template persists as a new database.

The final ignored load artifact is `load-results/smoke-1794697738264.json`.
The full `tsc --noEmit` check still reports the same 67 pre-existing test
diagnostics, with none in the changed files.

## Load lifecycle verification (infrastructure block 3)

Verified locally on 2026-11-14 at HEAD `4f1180e` plus this uncommitted block:

| Check | Result |
| --- | --- |
| Node launcher/manifest/CLI guards | 11 tests passed |
| Real PostgreSQL lifecycle and lock checks | 8 tests passed |
| Application unit regression | 1085 tests, 88 suites passed |
| Full ordinary e2e regression | 457 tests, 25 suites passed; 93.493 seconds |
| Isolated load modes | Smoke, concurrency, identity isolation, shared IP and mixed mail passed |
| Explicit retained modes | Two consecutive smoke runs and mixed mail passed |
| Smoke helper/runtime boundary coverage | 8 tests in 3 suites per smoke run |
| Build; lint without fixes; changed code formatting; diff whitespace | Passed |
| Prisma validation and retained migration status | Valid; all 39 migrations applied |

Database tests exercised both e2e and load copies, their isolation and deletion
after success/failure/interruption. A retained test inserted its own canary table,
failed the invocation, then verified the same physical database and preserved row
in a later invocation; it explicitly removed only its own canary table afterward.
Busy-template tests rejected both ordinary e2e and default isolated-load entrypoints.
No database-backed behavior was substituted with a mock.

Every two-process load scenario checked each replica's actual database OID and
lifecycle against the observer. The first concurrency attempt exposed a new
metadata serialization bug: Prisma returned OID as BigInt, causing JSON writing
to fail after the scenario. Both OID queries now explicitly return PostgreSQL
text; the full set of two-process scenarios then passed and reports serialized
correctly. Assertions, policy values and timeouts were not relaxed.

All eight successful load artifacts use schema version 2 and have `passed: true`:

- Isolated: `smoke-1794699934264.json`, `concurrency-1794700111840.json`,
  `identity-isolation-1794700178673.json`, `shared-ip-1794700184020.json`,
  `mixed-mail-1794700194229.json`.
- Retained: `smoke-1794700199616.json`, `smoke-1794700205098.json`,
  `mixed-mail-1794700210867.json`.

Files are under ignored `load-results/`. Each report records its state mode and
lifecycle UUID; retained invocations have distinct UUIDs while preserving their
database. The final inventory contained only `unicon_e2e_template`,
`unicon_load_test` and `unicon_test`, all owned by `unicon_e2e`. Template
connections were disabled with its existing ownership marker intact; the
container was healthy and both allocation-record directories were empty.
Full `tsc --noEmit` retains 67 pre-existing test diagnostics, with none in changed
files. No production auth behavior, production limits or provider integration
was changed. These bounded local scenarios do not establish production capacity.

The historical database cleanup is complete as recorded above. Automatic orphan
recovery remains a separate future task; it is not required to resume Stage 4 /
Iteration 7 block 2.3 after lifecycle verification.
