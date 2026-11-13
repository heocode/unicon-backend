# Local test infrastructure

## Current boundary

The first infrastructure block introduces one guarded execution path for
ordinary e2e and the existing load scenarios. It does not implement disposable
database cloning, template databases, backups or deletion of historical databases.
Auth Stage 4 / Iteration 7 block 2.3 remains pending during this infrastructure work.

| Use | PostgreSQL target | Database |
| --- | --- | --- |
| Ordinary e2e | localhost:5433, role `unicon_e2e` | `unicon_test` |
| Load stand | localhost:5433, role `unicon_e2e` | `unicon_load_test` |

Both targets belong to the dedicated Compose `postgres-test` service and volume.
The legacy `unicon-postgres` container on port 5432 belongs to the other workspace;
it is outside these launchers. The passwordless development service uses port
5434. Neither development nor legacy databases are test destinations.

The audit on 2026-11-13 found 17 user databases in the test container and two in
the legacy container, excluding PostgreSQL service/template databases. This
block preserves all of them. Historical verification documents retain the names
of the databases actually used at the time; those names are no longer accepted
by the ordinary e2e launcher.

## Execution contract

`scripts/test-runtime.mjs` provides target validation, a bounded environment,
temporary working directories, PostgreSQL ownership/locking and subprocess
lifecycle handling. Entrypoints are `scripts/run-e2e.mjs`,
`scripts/prepare-e2e-database.mjs` and `scripts/run-auth-load-smoke.mjs`.

1. Validate the target before connecting. Only the fixed database for the chosen
   command, `unicon_e2e`, localhost/127.0.0.1 and port 5433 are accepted. Query
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
   mutation occurs before locking. Verify the target database owner before
   migrations; create the fixed target only if absent.
4. Hold that connection throughout migration, compilation where needed, Jest and
   replica execution. Ordinary e2e always runs serially because suites share
   fixture tables. Standalone preparation takes the same lock, but releases it
   when preparation ends; the full launcher is required to protect a test run.
5. Preserve subprocess failure status. On SIGINT/SIGTERM or lock connection loss,
   abort the run and stop its own subprocess group, with a kill fallback. Finally
   close the lock connection and remove the invocation's temporary directory.
   No PostgreSQL backends are terminated and no databases or volumes are dropped.

Advisory locks coordinate cooperating launchers. They do not prevent arbitrary
manual SQL clients from changing the target. Test fixture cleanup can delete
test data inside its canonical database. Load runs retain their existing state
and unfinished-work preflight; this block adds no automatic recovery/reset.
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
actual canonical target, temporary cwd and public test credentials.

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

Next infrastructure blocks will define a migrated template and tracked per-run
temporary database lifecycle, then review historical databases for deliberate
cleanup. They require their own agreed boundaries before implementation.
