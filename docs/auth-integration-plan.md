# Passwordless integration plan and session handoff

## Agreed direction

The user wants visible progress through the actual registration/sign-in screens,
with checks on a device alongside development. The previous sequence spent too
long on internal infrastructure verification before exposing a usable flow.

After Stage 4 / Iteration 7 step 2.3.4, stop automatically advancing through the
remaining load-stand blocks. Finish the public authentication path using existing
services, connect the client incrementally, and verify each connected scenario.
Once authentication is complete, resume comprehensive load/fault testing and
production configuration calibration on representative infrastructure.

This changes execution order only. Preserve all accepted security contracts,
existing commits, tests and release requirements. Working screens are an
intermediate milestone, not evidence of production readiness. Do not replace
database-backed correctness checks with manual device checks or mocks.

## Starting checkpoint

- Repository: `/Users/vadimiskakov/Unicon/unicon-backend-passwordless`.
- Branch: `feature/passwordless`.
- Last implementation commit at handoff: `6fc4479`,
  `feat: isolate auth operation telemetry failures` (author heocode).
- Check actual HEAD and worktree on every resume. The handoff documents are
  committed separately from the last implementation commit. User-provided
  `makets/` is ignored by Git; preserve the local images, do not commit them.
- Stage 4 / Iteration 7 is not complete. Steps 2.3.1 through 2.3.4 are complete
  within their bounded scopes: rollback/cleanup, configuration mismatch/restart,
  retained-key addition/promotion, and telemetry receiver failure isolation.
- Block 2.3 remains formally IN PROGRESS in historical status notes. Safe old-key
  retirement and the full operational telemetry requirement are not completed.
  Keep v1 configured; promotion tests do not authorize removing it.

## Screen-to-code mapping

The actual local references are `makets/01.png` through `05.png` and
`makets/06-onboarding.png`. Inspect the images before proposing client behavior.
The user confirmed screen 01 is already implemented and a frontend repository
exists. Its path/framework remain unspecified here. Inspect that existing client;
do not rebuild screen 01. The nearest visible target is screens 02-03 requesting
a challenge through the backend and navigating to the code-entry screen 04.

| Screen | Intended behavior                              | Observed implementation at checkpoint                                                                      |
| ------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 01     | Welcome / Get Started                          | Client presentation; no auth request required                                                              |
| 02     | Choose college and enter institutional email   | University/AllowedDomain persistence exists; public selection API absent                                   |
| 03     | Confirm address and request code               | Internal challenge/admission/delivery services exist; public request endpoint absent                       |
| 04     | Enter OTP, show resend countdown               | Internal expiry/cooldown/delivery state exists; public response mapping and resend endpoint absent         |
| 05     | Confirm OTP and receive a session              | Transactional proof verification/consumption exists; user/session orchestration and public endpoint absent |
| 06     | Save first and last names after authentication | Profile contract documented; fields, mutations and onboarding flag not implemented                         |

Important existing components:

- `AuthenticationOperationService`: request/resend ownership, receipts and replay.
- `AuthenticationChallengeRequestService`: transactional live challenge
  reuse/creation; institutional-domain eligibility is the caller's responsibility.
- `AuthenticationDeliveryAdmissionService` and delivery workers: authoritative
  admission, stable-proof delivery and queue processing.
- `AuthenticationChallengeVerificationService`: OTP/link verification and shared
  atomic consumption inside a caller-owned transaction; not user/session creation.
- `SessionCreationService`, refresh, access guard and session management: existing
  session foundation to reuse while preserving its security guarantees.
- `GET /profile/me`: existing protected query; currently lacks profile names and
  `onboardingCompleted`.

The public AuthController still exposes the legacy password flow. The Prisma
User model still requires `passwordHash`; session authentication fields exist but
need wiring for the new flow. Plan the schema/runtime transition explicitly;
never manufacture a dummy password to bypass it.

## Execution sequence

1. **Request and resend through HTTP (Stage 5).** Connect validated institutional
   email and active-domain eligibility to existing operation/admission services.
   Provide explicit DTOs/errors, trusted source-IP/request accounting and current
   expiry/resend state. Verify on real PostgreSQL before exposing the path.
   College/domain selection needs a small public contract; no endpoint name or
   arbitrary client-selected affiliation is approved by this note.
2. **Proof to user and session (Stages 6/7 plus necessary dependencies).** Connect
   OTP and magic-link proof to account resolution/creation and the credential-neutral
   session layer. Preserve atomicity, stable User.id, account-state handling and
   the strict session cap, including consumed proof at the cap. Bring schema and
   legacy-transition dependencies forward as needed; they cannot be postponed
   behind a temporary insecure implementation.
3. **Connect screens 01-05 incrementally.** The user checks available scenarios
   on a device as their API dependencies become ready; do not wait for all auth
   or production work before every client check. Confirm the actual mobile repo,
   framework and launch workflow; the repo exists but its path is not recorded here.
   Do not assume permission to create a replacement web frontend. Complete
   restoration, duplicate-submit prevention, errors and link entry alongside UI.
4. **Connect onboarding entry and names (screen 06).** Follow Profile ownership:
   firstName/lastName, explicit onboardingCompleted and protected profile APIs.
   Route using GET /profile/me, not an accountCreated response flag. Returning
   users with incomplete onboarding must resume it too. Name saving alone is not
   automatically onboarding completion: the accepted flow includes later optional
   education/avatar screens and explicit completion. Do not pull media infrastructure
   into the first-name slice; confirm later screen scope separately.
5. **Finish remaining auth obligations.** Use Stages 7-11 as the dependency and
   acceptance inventory: remaining session policy, recent auth/deletion and explicit
   cancellation continuation, security events/notification policy, removal of legacy
   password runtime/storage and stable OpenAPI/mobile link integration. Required
   account-state behavior moves earlier when the sign-in path needs it.
6. **Comprehensive validation and release preparation.** Resume remaining Iteration
   7 and Stage 12 work after auth is connected: overload, process/network/provider
   faults, representative target-platform measurements, observability and tuning.
   Initial valid configuration and working protections are required throughout;
   final calibration is deferred, not configuration validation or enforcement.

These are outcome milestones, not a new requirement to invent nested iterations.
Before each implementation slice, explain what becomes usable, existing components,
files/dependencies and acceptance scenarios. Obtain agreement on that concrete
slice before editing application code. If its agreed approach must change, explain
the specific reason first. Avoid reopening the architecture without a blocker.

## Verification and visible progress

- Keep focused unit tests and real-PostgreSQL transaction/concurrency tests during
  development; add real HTTP/guard/DTO coverage as endpoints become connected.
- Report scenarios in plain language: actions, expected result, observed result,
  automated evidence and how the user can repeat the check on a device.
- Manual checks cover UX, navigation, app restart, resend, delayed mail, expired
  proof and repeat sign-in; they do not prove concurrency/rollback invariants.
- Reuse existing tests as regression coverage. Rerun checks appropriate to changes;
  do not rerun every long load scenario for every unrelated UI adjustment.
- Use isolated disposable PostgreSQL copies through the existing launchers.
  Fake loopback HTTP remains the load destination. Real provider delivery uses
  deliberately bounded checks; never send load traffic to live Resend by default.
- Local capacity results do not size Render/Railway or establish production quotas.

Last recorded verification for `6fc4479`: 1093 unit tests in 89 suites; full e2e
repeat 457/457 in 25 suites; new telemetry scenario passed twice; all eight prior
isolated modes and explicit retained mixed-mail passed; final smoke 14 tests in
six suites; 15 Node infrastructure tests; build/lint/scoped replica compilation
and Prisma validation/status passed (39 migrations). First full e2e attempt had
one unexplained verify-email 404; its suite passed separately and the full repeat
passed without code changes. Full tsc --noEmit still had 67 pre-existing test
diagnostics, none in the changed files. These are historical results, not fresh
claims for future revisions. Details: auth-iteration-7-load-stand.md, step 2.3.4.

## Deferred obligations to keep visible

- Remaining Iteration 7 overload and fault work, target-platform capacity tests
  and justified production policy/configuration values.
- Full operational metrics and documented analysis; current completion logs are
  not durable accounting or a complete metrics backend.
- Safe retirement of old rate-limit HMAC keys only after a separate controlled
  database-backed gate; retain v1 until then.
- Actual coordinated policy transitions must preserve active debt/cooldowns;
  mismatch/restart tests are not proof of arbitrary retuning safety.
- Live email/provider and mobile link behavior, production topology/proxy trust,
  secrets, backups, cleanup and other Stage 12 requirements.
- Every unfinished requirement in Stages 5-11; no public release on the strength
  of the happy path alone. Device integration runs on a controlled test stand.

## Next session: first action

Read AGENTS.md, this file, auth-architecture.md, auth-roadmap.md and the relevant
public-api-contract.md sections. Read profile-architecture.md before Profile work.
Verify HEAD/worktree and inspect the mockups; do not read .env secrets. Do not
resume the next Iteration 7 load block automatically.

Propose the first bounded Stage 5 slice: institutional-email challenge request
through HTTP using existing services, with DTO/guard/domain checks and real DB
acceptance scenarios. Assess authoritative expiry/cooldown response dependencies
before promising the public contract. State what the user can exercise afterward
and the next integration step. No automatic expansion to all endpoints or media.

Preserve existing changes. Future commits and pushes require an explicit request;
authorization for earlier commits does not authorize subsequent ones.
