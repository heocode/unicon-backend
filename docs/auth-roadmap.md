# Passwordless Auth and Profile Roadmap

This roadmap delivers the approved passwordless mobile contract in small,
verifiable stages. `auth-architecture.md` defines security and domain
invariants; `public-api-contract.md` defines the target HTTP surface.

There are no production users and no released mobile client. Legacy password
compatibility is therefore intentionally excluded. Historical migrations stay
immutable, but the current password runtime and schema are removed before the
passwordless branch is complete.

## Definition of passwordless-ready

The backend is ready for mobile integration when:

- one institutional-email flow handles both first registration and later
  sign-in;
- one challenge owns one stable six-digit OTP and one stable magic-link token;
- resend creates Delivery records without rotating or extending proof;
- OTP and magic link are atomically single-use and concurrency-safe;
- allowed-domain, account-state, enumeration, attempt, email, IP, and delivery
  protections are database-backed and tested;
- successful proof resolves or creates `User.id` and uses the credential-neutral
  session layer;
- refresh, logout, multiple sessions, session limits, and immediate revocation
  retain their existing security guarantees;
- account deletion uses recent authentication and explicit passwordless
  cancellation;
- generated OpenAPI and database-backed e2e tests match the public contract;
- password, legacy verification, and password recovery code and storage are
  absent from the v1 runtime.

## Confirmed product parameters

```text
OTP:                          6 decimal digits
challenge TTL:                600 seconds
OTP failure protection:       identity/IP short- and long-term GCRA
next-Delivery minimum interval: 60 seconds
recent-authentication window: 600 seconds
v1 delivery methods:          EMAIL
v1 proof methods:             OTP, MAGIC_LINK
```

V1 has no password, passkey, OAuth, personal recovery email, in-app proof
delivery, or push proof delivery. In-app/push security notifications are separate
from proof delivery and are planned in Stage 9/11. Loss of the institutional
mailbox has no self-service recovery in v1. Personal recovery email is planned
separately.

## Existing foundation to preserve

- Strict global DTO validation and stable public error envelopes.
- Validated runtime configuration through `ConfigService`.
- `AllowedDomain` and university mapping.
- Stable product ownership through `User.id`.
- Short-lived access JWTs and rotating refresh JWTs containing `sub` and
  `sessionId`.
- Hashed refresh-token storage and atomic one-time rotation.
- Server-side session/account checks for every protected request.
- Independent multi-device sessions and active-session limit.
- Session listing, naming, selected revocation, other-session revocation, and
  logout.
- Informational device metadata and optional degraded GeoIP.
- Append-only security events, notification delivery records, retention, and
  best-effort new-session notifications.
- Account deletion grace period, anonymized tombstone, and scheduler-operated
  finalization.
- Profile bootstrap and ownership through authenticated `User.id`.

## Stage 0: Documentation and contract freeze

- Replace password-MVP decisions in architecture, roadmap, README, development
  guide, public contract, and Profile bootstrap documentation.
- Define challenge, delivery, proof, account-state, concurrency, and recent-auth
  behavior before changing runtime code.
- Define endpoint names, DTOs, statuses, public errors, mobile headers, and
  deep-link exchange.
- Run a cross-document audit for contradictory password or rotating-resend
  behavior.

Exit condition: the documentation is internally consistent and approved.

## Stage 1: Add target persistence model

Create a new migration; never edit historical migrations or generated Prisma
files manually.

Add conceptually:

```text
AuthenticationChallenge
AuthenticationChallengeDelivery
AuthenticationRateLimit
Session.authenticationMethod
Session.authenticatedAt
```

The challenge stores stable keyed hashes, independently versioned hash protocol
and key material, fixed expiration, attempt counter, terminal timestamps, and a
versioned authenticated-encryption envelope required to reproduce stable proof
for delivery. Delivery stores only provider-neutral attempt state and
idempotency, never proof.

Keep target-obsolete storage temporarily during the expanding migration so the
existing runtime remains buildable:

```text
User.passwordHash
User.hashedVerificationToken
User.verificationTokenExpires
User.verificationEmailSentAt
PasswordResetToken
PasswordResetRateLimit
```

Review whether unused `lastLoginAt`, `loginAttempts`, and `lockoutUntil` remain
useful under the new event/rate-limit model. Remove them if no explicit owner
and behavior remains. Password and legacy verification/recovery columns are
removed in the contract migration together with the runtime code in Stage 10,
not in this additive stage.

`PENDING` is no longer created in the target flow. Because PostgreSQL enum
contraction requires care, removal of the enum value may be performed in this
stage or a later cleanup migration; runtime must still handle any transitional
row safely.

Update account finalization so it removes authentication material without
generating a discarded password hash.

Required verification:

- Prisma generate and validate;
- migration review for intentional password/recovery data removal;
- migration application against an empty dedicated test database;
- schema and finalization unit tests.

## Stage 2: Challenge cryptographic primitives

Implement focused services for:

- unbiased secure six-digit OTP generation;
- 256-bit magic-link secrets;
- versioned HMAC hashing and constant-time comparison;
- versioned authenticated encryption/decryption used only for delivery;
- immutable, independently versioned hash and encryption protocol encodings;
- one active key snapshot per generated hash set or encrypted envelope;
- clearing encrypted proof when a challenge becomes terminal;
- fixed challenge lifetime;
- purpose validation;
- diagnostic OTP-failure accounting; the implemented Stage 2 five-failure lock
  is transitional and must be retired only through the gated Stage 4 transition;
- atomic consume shared by OTP and magic link;
- expired challenge cleanup.

Cleanup uses short, independently committed PostgreSQL batches with
`FOR UPDATE SKIP LOCKED`. It clears expired encrypted envelopes without
changing consumption or lock state, then deletes challenges at their persisted
`retentionExpiresAt` boundary with Delivery cascade. Envelope cleanup and
retention deletion fairly share one configured maximum batch budget per run;
the scheduler is non-overlapping within one process and safe across replicas.
Cleanup failures remain degraded background failures and never prevent
authentication startup or requests.

Raw, hashed, or encrypted proofs never enter logs or security events. HMAC and
encryption keys are independent from each other and from JWT and rate-limit
secrets, and are validated at startup.

Required unit tests include format, entropy source boundaries, hash binding,
wrong purpose, expiry, replay, and concurrent consumption. Existing fifth-attempt
lock tests document current runtime until replaced by Stage 4 GCRA/no-attempt-
lock tests at the enforcement integration gate.

## Stage 3: Delivery abstraction and email

Stage 3 produces an internal, provider-neutral delivery capability for an
already-created challenge. Public challenge and resend endpoints remain in
Stage 5. Implementation is split into these independently verifiable
iterations:

1. freeze the Delivery state machine, persistence constraints, origin,
   ownership lease, attempt accounting, idempotency window, and retention
   contract; add an additive migration where required;
2. implement atomic create, claim/reclaim, sent, retry, and failed repository
   or cancelled repository transitions with UUID lease ownership,
   supersession, processing-budget exhaustion, and database-backed stale-worker
   tests;
3. implement the approved client-neutral canonical magic-link URL, Universal
   Link/App Link, non-consuming GET, referrer-safe token handling, and HTTPS
   fallback contract;
4. implement the provider-neutral email port and provider adapter with safe,
   ambiguous, accepted, and terminal result normalization;
5. implement responsive HTML and plain-text Unicon email templates using the
   approved sender/subject contract and Figma visual reference;
6. orchestrate claim, challenge eligibility, transient decrypt, link building,
   render, provider submission outside the transaction, and lease-owned state
   transition;
7. implement bounded retry workers, lease recovery, graceful shutdown, and
   Delivery retention cleanup;
8. complete unit and database-backed end-to-end coverage for the entire
   delivery protocol. Mandatory integration tests establish reachability of
   PENDING Deliveries for expired, consumed, and locked challenges through
   cancellation and retention; compare application-level submissions across
   two real repository/read/decrypt/build/render/provider attempts; and cover
   crash, expired lease, reclaim, successful send, and rejection of every late
   transition under the old lease. An in-flight resend integration test also
   verifies ownership revocation without pretending to cancel provider I/O.

Iteration 8 integration uses the real PostgreSQL repository and cryptographic
and rendering services with only the email provider replaced by a fake. No
real email is sent. Docker image packaging, real email-client rendering,
production association files, HTTPS fallback deployment, and real provider
delivery remain separately verified integration/production gates; automated
backend tests do not establish those external behaviors.

Iteration 3 first freezes the backend construction contract with the exact
`AUTH_MAGIC_LINK_PUBLIC_URL=https://uniconnection.app/auth/verify` setting,
shared canonical UUID/token validators, and deterministic URL test vectors.
The setting is not silently normalized. Mobile association files and the safe
fallback document remain deployment/client integration work within the same
Stage 3 contract; neither may turn `GET /auth/verify` into proof verification.
That client-neutral GET never consumes a challenge, creates a user, or creates
a session. Only the separate POST verification flow may do so.

The resulting internal flow is:

```text
challenge proof
→ AuthenticationChallengeDelivery
→ EMAIL adapter
→ provider result
```

One challenge keeps one OTP and link. A new challenge receives an `INITIAL`
Delivery; each successfully admitted explicit resend creates a new `RESEND`
Delivery referencing the same proof with a new idempotency key. Repeated initial
requests return a reusable live challenge without automatic Delivery creation.
A provider retry reuses the same Delivery, delivery ID, and idempotency key. It never becomes a resend.

`PENDING → PROCESSING` claim creates a UUID lease and expiry and increments an
operational fail-safe work counter. `markSent`, `scheduleRetry`, `markFailed`,
and `markCancelled` must match that lease. Expired processing may be reclaimed
with a new lease while the counter is below five; at the limit it is atomically
terminalized and cannot receive a sixth claim. The stale worker loses mutation
authority. Selection and claim occur in one short transaction using
`FOR UPDATE SKIP LOCKED`; network calls never occur inside a database
transaction.

Provider retry results distinguish `SAFE_RETRY` from `AMBIGUOUS_RETRY` and may
carry a normalized HTTP `Retry-After` hint in delta-seconds or HTTP-date form.
Only an explicit rate-limit rejection is classified safe in V1; unknown
outcomes and 5xx responses are ambiguous. Ambiguous retry always reuses the same
idempotency key and must stop before the provider's documented idempotency
window ends. Only allowlisted failure codes are persisted.

Immediately before delivery, the lease owner rechecks challenge consumption,
terminal state, expiration, and complete-envelope state. Current Stage 3 OTP-
attempt-exhaustion checks must be updated at the gated lock-removal transition. An in-flight
email may still complete if challenge state changes after that check; proof
remains unusable because verification rechecks state. Partial encrypted
envelopes violate a database invariant and are internal corruption, not an
ordinary failed Delivery.

`FAILED` represents terminal provider, request, configuration, or explicitly
classified internal invariant failure.
`CANCELLED` means proof should no longer be sent, initially for
`DELIVERY_WINDOW_CLOSED`, `CHALLENGE_UNAVAILABLE`, or
`SUPERSEDED_BY_RESEND`. Consumed, locked, and expired challenges cancel their
non-terminal Deliveries. Partial envelopes enter neither ordinary terminal
path.

Every Delivery persists `templateProtocolVersion`. Immutable recipient, From,
subject, HTML, text, and versioned CID attachment metadata and bytes are
separate from operational `deliveryId`,
`idempotencyKey`, and template-version context. V1 has no generic provider
request-options bag. Provider retries must reproduce byte-equivalent content
through that immutable renderer version and reuse the same idempotency key.
Deploying a new template version cannot change an existing Delivery payload.

The approved V1 retry policy is:

```text
MAX_DELIVERY_PROCESSING_ATTEMPTS = 5
BACKOFF = immediate, then 5s, 15s, 30s, 60s after completion
JITTER = uniform [0.8, 1.2], policy delay only
HTTP_TIMEOUT = 10s
PROCESSING_LEASE_TIMEOUT = 45s
MIN_DELIVERY_VALIDITY_REMAINING = 120s
RESEND_IDEMPOTENCY_WINDOW = 24h
```

Because claim increments `attemptCount`, backoff uses an explicit mapping:

```text
attemptCount 1 after processing → 5s retry delay
attemptCount 2 after processing → 15s retry delay
attemptCount 3 after processing → 30s retry delay
attemptCount 4 after processing → 60s retry delay
attemptCount 5 after processing → no retry; budget exhausted
```

The policy service must cover this exact mapping with a unit test and must not
rely on implicit array indexing.

Jitter is computed once at retry scheduling with injectable randomness, stored
in `nextAttemptAt`, and never recomputed by claim. Effective retry time is the
later of jittered policy backoff and provider `Retry-After`; provider delay is
never shortened. Both scheduling and provider submission enforce 120 seconds
of remaining challenge validity. Safe and ambiguous retries share the same
five-claim budget. Ambiguous retry additionally requires the same Delivery,
idempotency key, deterministic application-level payload, and active
challenge. The ten-minute challenge lifetime is below the enforced 24-hour
provider idempotency window, so V1 needs no separate runtime cutoff.

The delivery worker runs every second with four processing lanes per replica
and at most twenty claims per cycle. Effective provider concurrency is
`replica count × 4`; V1 adds no distributed global semaphore. A lane claims
only when free and never stores a pre-claimed local queue. SQL claim ordering
uses the oldest eligibility timestamp across initial pending, scheduled retry,
and expired-lease reclaim candidates, then `createdAt` and `id`, preventing
starvation while retaining `FOR UPDATE SKIP LOCKED`. Exceptions escaping the
classified orchestration contract are unexpected; the worker records safe
metadata only and leaves recovery to lease expiration.

Historical Stage 3 implementation: manual resend creates a new RESEND Delivery
and supersedes unfinished work, revoking lease ownership without guaranteeing
physical cancellation. The accepted V1 target below replaces this behavior in
Iteration 4: return existing unfinished work instead of superseding it. Current
Stage 3 tests cover historical ownership semantics, not the new target.

Email requirements:

- code prominently in the body for mobile copy, paste, and AutoFill UX;
- magic-link Universal Link/App Link plus HTTPS fallback;
- no account-state disclosure;
- no raw proof in application logs or persisted provider errors;
- fixed challenge expiry wording;
- failure recorded without consuming, resetting, unlocking, or extending the
  challenge.

Required tests cover initial delivery versus resend, stable proof across
deliveries, provider idempotency reuse, concurrent claims, lease expiry and
stale workers, safe and ambiguous retry, retry hints and the configured
idempotency-window invariant, successful and terminal delivery, process failure around provider
submission, terminal challenge races, proof non-persistence, bounded workers,
and retention.

Stage 3 decision 1 is approved:

```text
https://uniconnection.app/auth/verify?challengeId=<canonical UUID>&token=<canonical magic-link token>
```

`uniconnection.app` is a client-neutral public origin that can support iOS,
Android, and future web authentication. `GET /auth/verify` expresses auth
intent but never verifies or consumes proof. The separate POST flow performs
verification, after which the client chooses a destination based on purpose
and returned state. Referrer protection, an analytics-free route, early
browser-URL token removal, and fallback behavior belong to Iteration 3.

Iteration 3 must also deliver and verify:

- a minimal first-party fallback with no third-party resources, tracking,
  analytics, or session replay;
- canonical UUID and magic-token parsing before POST construction, with the
  backend independently validating both values;
- in-memory-only token handling followed immediately by
  `history.replaceState`, before normal UI or integrations execute;
- no verification without a separate explicit POST action;
- `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, restrictive CSP,
  and search-engine exclusion on the fallback response;
- token-query redaction across CDN, proxy, server, application, error, and
  crash logs;
- `/.well-known/apple-app-site-association` and
  `/.well-known/assetlinks.json`, scoped to the required authentication route.

Stage 3 decision 2 is approved. Delivery uses:

```text
From: Unicon <noreply@uniconnection.app>
Subject: 482731 — Your Unicon sign-in code
```

`AUTH_EMAIL_FROM=Unicon <noreply@uniconnection.app>` is an exact validated
backend setting. The adapter rejects a mismatched sender before network I/O.

The generated six-digit OTP replaces the example and is also prominent in the
body. Showing it in the subject intentionally favors passwordless notification-
preview UX; the accepted security trade-off is bounded by fixed challenge TTL,
attempt limits, atomic single use, and replay protection. Hidden notification
previews must not make the body unusable.

The email is OTP-friendly, while actual AutoFill remains a separate mobile
enhancement. Native inputs use appropriate iOS and Android hints, and behavior
is tested on real devices with representative Apple Mail, Gmail, and Outlook
clients. Stage 3 does not promise successful OS extraction. The magic link
remains an alternative proof requiring no manual code entry.

Stage 3 decision 3 is approved: Figma file `DzXnzo9NGRISTJtlRXb8T0`, frame
`130:173`, is the authoritative V1 visual reference, adapted only as required
for responsive HTML, plain text, dark mode, blocked assets, and email-client
compatibility.

Stage 3 decision 4 is approved as the retry policy and semantics above. All
four Stage 3 product and architecture decisions are closed; there are no
remaining open decisions before Iteration 1.

## Stage 4: Database-backed abuse protection

**Iterations 1–2: COMPLETE — policy semantics, configuration, key derivation,
and exact GCRA state foundations; no Stage 4 limiter enforcement is claimed.**
The canonical consolidated register is
[Stage 4 Iteration 1 — consolidated policy register](auth-architecture.md#stage-4-iteration-1--consolidated-policy-register).
It records 12 accepted protection rules, shared charge/denial/transaction/privacy
contracts, lifecycle prerequisites, and explicit deferred owners. The seven
iterations below are unchanged. Current: Iteration 3 atomic PostgreSQL limiter,
without another policy-design round. Global capacity numbers remain measurement-gated before
production; deferral is intentional and does not mark them as chosen defaults.

Stage 4 delivers layered auth abuse protection before public Stage 5–6 flows.
Keep HTTP requests, admitted Deliveries, provider submission attempts, and proof
failures distinct. Apply keyed database-backed protection before account lookup
where required, with independent identity/IP protection, challenge-scoped
lifecycle/cooldown, and separate global admission/provider pressure. No additional
device/install or composite verification buckets are selected for V1. A small enforcement core may accept
policy identity and canonical characteristics without auth-specific assumptions;
do not build speculative DSLs or future non-auth policies. Raw email and IP
bucket inputs are not stored.

The former five-Deliveries/identity/hour target is superseded by the accepted
Delivery-budget UX capacity requirement in auth-architecture.md: starting with
unused budgets and no unrelated traffic, cover initial admission plus eight
Resends through 08:00 of one challenge and one initial Delivery for a replacement
challenge after expiry. This is a ten-Delivery reference scenario, not a
final ten/hour policy. Email Delivery GCRA is now accepted below with burst 10
and rate 7/hour, together with IP burst 120/rate 240/hour. Assess shared-IP
usage and email-bombing exposure using operational data.

IP Delivery GCRA burst 120/rate 240/hour supersedes the former twenty/hour
target. Reassess the former twenty-verification-attempts/IP/15-minute target
under the accepted failure-only independent identity/IP policies; it is not a
fixed all-attempts limit. The existing five-failure runtime lock is superseded
in the target by the accepted gated removal below. GCRA applies to accepted
request, Delivery, verification, and shared provider-rate policies; minimum
interval cooldown remains admission-anchored. Global capacity parameterization
and numeric values are deferred to Iterations 6–7 measurements. No additional
fixed-window policies are implied.

### Accepted cooldown decision

**ACCEPTED / FIXED:** AUTH_CHALLENGE_DELIVERY_COOLDOWN uses challengeId as its
canonical characteristic and the existing AuthenticationRateLimit table as an
opaque challenge-scoped bucket. NEXT_DELIVERY_MIN_INTERVAL is 60 seconds of
validated V1 configuration. The minimum interval is between DB-authoritative
admission timestamps of successfully committed admissions, not commit
timestamps. Obtain fresh DB time after necessary waits/locks inside the atomic
admission transaction; count=1 and windowEndAt=admissionOperationNow plus the
configured interval take effect only on commit. Rollback preserves no partial
admission charge, Delivery creation, or cooldown establishment.

**ACCEPTED / FIXED:** also enforce AUTH_IDENTITY_DELIVERY_COOLDOWN with the
normalized institutional email as its characteristic and an opaque bucket in
the same persistence. Require at least 60 seconds between admission timestamps
for that email across all challenges, IPs, clients, and purposes. Initial,
Resend, and Request new code check it; creating a challenge alone does not set
it. Replacement after expiry preserves the remaining wait. For the target flow, initial
admission at 00:00 and Resend at 00:06 means 54 seconds remaining,
not a new 60-second penalty. Wrong OTPs no longer force replacement in the
target; reusable challenges remain authoritative after failures. Replacement challenge + initial Delivery + applicable charges
and cooldown state commit atomically; denial does not persist a replacement
flow. Use the later applicable challenge/identity boundary for cooldown
retry-after. Provider results, denial, and rollback do not move active boundaries.

Cooldown denial never moves the boundary, creates/supersedes a Delivery, revokes
a lease, or changes proof, TTL, or failedAttemptCount. Provider results never
start, reset, or refund it. All next-Delivery creation paths share admission;
repeated initial requests only return a reusable live challenge. Another identity
has its own challenge cooldown without resetting other abuse accounting.

Check lifecycle and Stage 3's minimum remaining submission validity (V1: 120
seconds) before new-admission mutations. Resolve existing unfinished work without
creating or charging another Delivery or moving cooldown. Otherwise charges,
creation, and cooldown establishment are atomic. At most one PENDING/PROCESSING
Delivery may exist per challenge, including under concurrent requests. New
PENDING work becomes available after commit without a second user action.
Temporary provider gate exhaustion does not deny admission if global admission
and backlog allow work; provider submission still respects its restrictions.
The canonical detailed contract is in
`auth-architecture.md`, “Accepted next-Delivery minimum interval”.

### Accepted email Delivery GCRA

**ACCEPTED / FIXED:** normalized-email Delivery budget uses GCRA burst 10 and
sustained rate 7 admitted Deliveries per 3600 seconds (one allowance per 3600/7
seconds, about 8 minutes 34.286 seconds). These are configurable V1 starting
values. It is not a strict seven/hour or ten/hour quota; from idle state its
envelope permits up to sixteen admissions in the first hour if other rules
allow. Keep the independent 60-second identity/challenge minimum interval.

Initial, Resend, and replacement initial Delivery each charge one unit on
successful commit, independent of IP/challenge. Resolution without a new
Delivery, denied admission, and rollback do not charge. Provider failure does
not refund and retries of the same Delivery do not charge again. Use a separate
opaque TAT; atomically compose GCRA and other Delivery charges, cooldowns,
creation and replacement challenge persistence. Cleanup/config
changes/rotation must not reset debt. Preserve exact fractional arithmetic and
round only public wait seconds. Compose with the accepted IP policy below.

Iterations 3–4 and 7 must cover the reference ten-Delivery scenario, continued
recovery (#11 at elapsed 11:00, next allowance at approximately 17:08.571),
expiry versus email eligibility, multi-IP/multi-challenge shared email debt,
denial immutability, rollback, and provider retry/failure accounting. This
policy denies new email admission, not existing proof verification. Use
analytics to tune the recovery/bombing trade-off; preserve separate request,
global, and provider protection.

### Accepted IP Delivery GCRA

**ACCEPTED / FIXED:** canonical source IP Delivery budget uses GCRA burst 120
and rate 240 admitted Deliveries per 3600 seconds (one allowance per fifteen
seconds). Aggregate initial/Resend/replacement initial admissions across emails,
challenges, and clients on that IP. Values are configurable V1 starting points
for shared networks, not a strict hourly quota or campus capacity guarantee.

Email and IP Delivery budgets are independent and must both permit admission.
Charge one unit to each only with committed Delivery creation and other atomic
admission mutations; denial/rollback cannot leave partial charges or supersede
existing work. Resolution without a Delivery and retries do not charge; provider
failure after admission does not refund. Independent IP TAT survives identity/
challenge changes and uses the common GCRA concurrency, configuration, privacy,
cleanup, and analytics guarantees. No added timed penalty or periodic reset.

Iterations 3–4 and 7 cover fifty initial admissions plus fifty Resends after a
minute from one idle IP, multi-email aggregation, concurrent email/IP denial,
atomic rollback, retry accounting, and configuration/cleanup safety. Preserve
independent request/global/provider protections and the 60-second email interval.

### Accepted verification mitigation boundary

**ACCEPTED / FIXED:** temporary verification-policy mitigation denies only the
verification operations covered by that policy. It does not itself block
initial request/Resend/Request new code, change account status, revoke sessions,
or lock/consume challenges. Independent request/Delivery policies still apply;
new challenges do not reset applicable verification abuse state. The current Stage 2 lock stays only until the gated
GCRA/no-attempt-lock transition below is implemented.

**ACCEPTED / FIXED:** use independent normalized-identity and IP buckets, not
only a composite (identity, IP) bucket. Identity aggregates applicable failures
across challenges and IPs; IP aggregates them across identities. Both must allow
verification. Select a larger IP budget for legitimate shared-network usage,
with effective allowances compared over the chosen windows. These policies count
only unsuccessful checks; successful verification does not consume failure
budgets, but remains subject to independent request/resource protection.

**ACCEPTED / FIXED:** charge both verification failure budgets only for a
canonical OTP or magic-link proof mismatch against an eligible challenge with
correct purpose/binding. Only OTP mismatch additionally increments the Stage 2
diagnostic counter if retained. Fifth and later OTP mismatches remain chargeable
when policies permit, without terminalizing the target challenge. Requests to
historical terminal/locked rows are not further mismatches. Malformed proof, missing or terminal
challenge, purpose/binding rejection, success, policy denial, and infrastructure
errors do not consume proof-failure budgets. Independent request protection
must cover excluded traffic; classify domain outcomes rather than HTTP statuses.
Preserve expiry cleanup; retire legacy attempt-limit self-heal at the gated
transition.

**ACCEPTED / FIXED short-term verification:** use GCRA, replacing fixed-window
counting, a separate 60-second denial, and full-reset recovery. Identity has
burst capacity 6 and sustained rate 6 failures per 60 seconds; IP has burst
capacity 72 and sustained rate 72 per 60 seconds. Capacity returns continuously
(identity one per ten seconds, IP one per 5/6 second). These are burst-plus-rate
limits, not strict rolling-window maxima or user concurrency caps.

Store rate debt as theoretical arrival time (TAT). Only committed chargeable
mismatches advance it; success, excluded outcomes, and denied requests do not.
Both buckets must allow verification. Denial lasts only until GCRA eligibility
returns, with one DB-authoritative retry-after from the latest applicable
eligibility boundary. Do not add a timed penalty or let denied retries extend
waiting. Preserve exact burst semantics and subsecond internal precision.

New challenges do not reset TAT, rate recovery does not unlock challenges, and
short-term recovery does not reset independent long-term state. GCRA remains
PostgreSQL-backed; select its TAT persistence and safe cleanup in Iterations
2–3 without changing cooldown semantics. Endpoint coverage,
concurrency/transaction accounting, and remaining recovery details
are still open. No cross-operation source block is accepted. Test shared-IP
interference, targeted identity exhaustion, and successful verification not
spending budgets. Revisit Delivery quota candidates after reviewing the combined
policies; failure-only controls do not stop bombing without verification.

### Accepted long-term identity verification

**ACCEPTED / FIXED:** independent identity GCRA with full burst capacity 8 and
sustained rate 12 chargeable failures per 3600 seconds, recovering one allowance
per 300 seconds. These are initial configurable V1 values for later analytics-
based tuning, not a strict rolling/fixed-window quota. Burst eight supersedes
the earlier burst-twelve value; sustained replenishment stays unchanged. For
risk review only, without the existing OTP lock and with idle budgets/atomic
enforcement, combined identity policies permit nine guesses in [0, 600) seconds:
0.0009% random success for one uniform six-digit proof with distinct guesses.
This is not an aggregate risk bound. The accepted target lock removal below
explicitly accepts this per-proof trade-off, gated on enforcement integration.

Use the same failure categories and normalized identity across IPs/challenges.
Maintain separate TAT from short-term state; all applicable policies must allow
verification. Success/denial/excluded outcomes do not charge, and challenge
replacement or short-term recovery does not reset long-term debt. No separate
timed penalty or periodic reset. Apply shared GCRA configuration, persistence,
retry-after, cleanup, and telemetry requirements. Test the combined short/long
eligibility and state independence in Iterations 3, 5, and 7.

### Accepted long-term IP verification

**ACCEPTED / FIXED:** IP GCRA burst capacity 360 and sustained rate 360
chargeable failures per 3600 seconds, restoring one allowance per ten seconds.
These are initial configurable V1 values for analytics-based tuning, not a strict
360/hour quota or campus concurrency guarantee. Aggregate the same accepted
mismatch categories across identities/challenges from one canonical source IP.

Keep TAT independent of the other three verification buckets. All four policies
must permit verification; charge applicable buckets atomically on mismatch and
use the latest blocking eligibility for retry-after. Success, excluded outcomes,
and denied requests do not charge. No separate timed penalty, periodic reset, or
cross-operation block. Challenge/identity changes and short-term recovery do not
erase IP debt. Preserve short-term burst 72/rate 72 per minute alongside this
policy. Test sustained multi-identity abuse and shared-IP contention, state
independence, retry-after composition, and safe configuration/cleanup in
Iterations 3, 5, and 7.

### Accepted removal of automatic OTP attempt lock

**ACCEPTED / FIXED target:** remove permanent challenge lock after five wrong
canonical OTPs. Users wait for GCRA capacity and continue verifying the same live
challenge/proof, without Request new code solely because of mistakes. Preserve
600-second expiry, stable proof, atomic consumption, correct binding, explicit
invalidation, and historical terminal state. Expiry still requires a new flow.
The 0.0009% modeled per-proof guessing risk versus 0.0005% for five guesses is
an accepted UX/security trade-off under the stated GCRA assumptions.

Runtime removal is gated on integrated, atomic, database-backed enforcement of
all four verification policies and passing concurrency/failure/retention checks.
If authoritative limiter state cannot be read or charged, fail closed before
session issuance; return technical unavailability rather than fabricated 429.
Do not introduce a standalone lock-removal patch before enforcement is ready.

Iterations 3 and 5 must review schema constraints/legacy fields, repository
attempt-limit/self-heal, envelope clearing, Delivery eligibility/cleanup,
configuration, errors/events, and tests together. Add migrations/regenerate
Prisma as required; never reopen historical locked rows or reset GCRA debt.
Stage 6 connects the public HTTP/client behavior. Iteration 7 verifies the full
transition. FailedAttemptCount may remain diagnostic, but cannot gate usability.
Concrete field-retirement and transaction design remain implementation work.

Verification transaction semantics are accepted below/in auth-architecture.md;
concrete concurrency, persistence, and recovery work has the owners listed in
the consolidated register and does not reopen Iteration 1.

### Accepted public passwordless request policy

**ACCEPTED / FIXED V1 starting values:** GCRA burst 200 unit requests and rate
600 per 60 seconds (10/second), with one canonical-IP bucket shared by POST
challenge request, resend, verify-otp, and verify-link. Each request admitted
through this policy costs one, regardless of later outcome; charge before JSON
parsing, DTO validation, and domain services and retain charge through downstream denial or
rollback. A request-policy denial does not advance TAT or reach domain logic;
return the stable 429 envelope and authoritative retry-after. Infrastructure
failure is fail-closed technical unavailability, not a synthetic 429.

Use a reusable HTTP enforcement mechanism outside Auth with explicit route
groups. Do not automatically group Profile/Clubs/Events, refresh/protected session
operations, STEP_UP routes, or the GET fallback into this public auth bucket.
Other resources will select independent policies. Weighted request costs are
not needed for V1. ACCEPTED / FIXED: cover malformed JSON with the same unit
request charge only; no verification/Delivery charges or challenge mutations.
Request denial must stop before parser/domain execution. No separate malformed
limiter in V1; collect privacy-safe parser error metrics. Accept shared-IP
starvation risk and validate campus behavior with load tests and pilot traffic.
Source-resolution/canonicalization responsibility is fixed below. Deployment
proxy trust/header choices, concrete pre-parser integration, and exact technical
error mappings remain open. Parameters are configurable operational
starting points, not measured capacity or a strict 600-per-minute window cap.

Iterations 2–3 prepare policy configuration, opaque IP keying, and atomic
standalone request charging; Stage 5–6 integrate the selected HTTP boundary.
Add HTTP/e2e coverage for cross-endpoint sharing, unit charging before parsing,
malformed JSON charging only request capacity, no refund after domain rejection,
denied requests not extending wait or invoking parser/services, infrastructure
fail-closed before parsing, parser-error telemetry, and independence from
other route-group buckets. Iteration 7 verifies burst 200/rate 10 per second,
shared-IP waves, many IPs, hot-bucket contention, denied-request DB cost, and
latency/errors under load. Distinguish measured backend capacity from policy
fit: pilot/production traffic is needed to tune legitimate shared-network use
and abuse, rather than treating synthetic load alone as threshold validation.

### Accepted source IP resolution/canonicalization contract

**ACCEPTED / FIXED target:** source resolution selects one IP at the HTTP boundary
under explicit deployment trusted-proxy configuration. Keep this distinct from a
hosting-independent canonicalizer accepting exactly one IP literal and strictly
validating/normalizing with the existing ipaddr.js dependency. No custom regex
normalization, address guessing from lists or IP-with-port values, or automatic
fallback through arbitrary headers. Use Express request.ip by default; any
platform-specific source-header integration must have an explicit trust contract.

Convert IPv4-mapped IPv6 to IPv4, normalize IPv6 deterministically, and preserve
private/loopback IPs. Do not inherit GeoIP's public-only filtering. Resolve once
per request and share the canonical IP across independent IP-based policies.
Missing/untrustworthy source IP or invalid canonicalization fails closed on
protected auth endpoints as technical failure, not a fabricated rate-limit denial.
IPv6 prefix policies remain deferred until needed.

Iteration 2 defines/tests the strict literal contract and opaque characteristic
encoding; Stage 5–6 connects the resolver before parsing. Test equivalent address
forms, mapped IPv4, private/loopback, malformed/ambiguous inputs, and fail-closed
behavior. Exact public errors remain to decide. Apply the accepted proxy trust
boundary below; exact addresses/ranges and header mechanism are deployment values
to choose and validate before staging. No runtime configuration changes are
made by this entry.

Iteration 2 implementation: `canonicalizeIp` in `src/common/utils`
provides the standalone strict single-literal canonicalizer, with unit coverage
for equivalent IPv6 forms, mapped IPv4, private/loopback addresses, and rejected
ambiguous/transport inputs. It uses Node.js `isIP` for strict syntax validation
and ipaddr.js for address parsing and canonical representation. Whitespace,
zone identifiers, CIDR, brackets, forwarding lists, and legacy IPv4 syntax are
rejected with an internal error that contains no input value. IPv4-compatible
IPv6 remains IPv6; only IPv4-mapped IPv6 becomes IPv4. Source resolution and HTTP
error mapping/enforcement remain Stage 5–6 work. The other completed Iteration 2
foundations are recorded under configuration and persistence below.

### Accepted deployment proxy trust boundary

**ACCEPTED / FIXED target:** source resolution is explicitly configured as direct
or proxy-only; header presence never selects trust or mode. Direct uses socket
peer IP and ignores forwarding headers. Proxy-only requires a trusted immediate
peer and rejects untrusted access on protected auth endpoints.

For X-Forwarded-For-style chains, traverse from socket peer through trusted hops,
right to left, to the first untrusted address. A single-IP header mechanism
requires an ingress contract that authoritatively sets the value and sanitizes
client input. No automatic fallback between X-Forwarded-For, X-Real-IP,
CF-Connecting-IP, other headers, or socket IP when the required trusted source
fails. Missing/malformed/untrustworthy sources fail closed; canonicalization
stays independent and receives one IP literal. Public error mappings remain open.

Validate required configuration at startup and reject missing/contradictory
production trust settings, blanket implicit trust, and implicit mode selection.
Before staging choose exact proxy addresses/ranges and header mechanism; verify
actual topology, sanitization, trusted-chain behavior, and origin-bypass defense.
Stage 5–6 HTTP integration tests and staging deployment tests cover spoofed
headers, direct/untrusted peers, missing/malformed sources, and supported chains.
Repeat topology validation on hosting/edge changes. No runtime/configuration
change is made by this documentation decision.

### Accepted auth Delivery backlog accounting

**ACCEPTED / FIXED:** one aggregate auth backlog counts PENDING (including retry
and provider-capacity waits) and PROCESSING Deliveries. SENT/FAILED/CANCELLED do
not count; retries do not add units. This does not cover notification backlogs
or bound in-flight provider calls after supersession.

Enforce free-capacity reservation atomically with new Delivery admission across
replicas. V1 resend resolves existing PENDING/PROCESSING work, preserving leases,
retry schedules, quotas, and cooldown; it does not supersede or replace it.
Resolving existing work requires no new slot, including at full backlog. Any new
Delivery requires a free slot. Concurrent initial/resend requests must preserve
at most one unfinished Delivery per challenge. Do not commit a new challenge
without initial Delivery on denial or invalidate existing proof because another
Delivery cannot be admitted. Temporary provider gate exhaustion alone does not
deny otherwise admissible work.

Iteration 6 composes backlog enforcement with Iteration 4 admission. Iteration 7
verifies exact capacity under concurrency, unfinished-work resolution at full
backlog, terminal transitions, retries/recovery, rollback, and cleanup progress.
Lease expiry alone does not release capacity; obsolete work must terminalize.
Preserve submission-validity checks after waits. Numerical backlog/global-rate
thresholds remain open. Internal denial semantics are fixed below; HTTP mappings
and user retry UX remain Stage 5–6 work.

### Accepted Global Delivery Admission denial and commit semantics

**ACCEPTED / FIXED target:** GLOBAL_RATE_DENIED carries authoritative retryAfter
from persisted limiter state/DB time. DELIVERY_CAPACITY_UNAVAILABLE means full
backlog with unknown exact release time. INFRASTRUCTURE_FAILURE is technical
unavailability and must not be masked as policy denial. Reliably established
denial admits no new work and preserves atomicity: no partial admission charges,
cooldown, challenge, or Delivery mutations. Separately committed request charges
remain. Returning existing unfinished work is not new admission.

Connection loss during commit is an uncertain outcome, not confirmed rollback.
Iterations 4/6 must provide durable operation reconciliation or equivalent safe
idempotent retry, preventing duplicate Deliveries/admissions and repeated budget
charges. Provider submission idempotency and the one-unfinished-Delivery invariant
alone do not resolve this, especially after earlier work becomes terminal. Do
not refund or invalidate proof based solely on a lost commit acknowledgment.
Iteration 7 covers failure injection around commit, concurrent retries, and
terminalization before retry. Concrete persistence/operation identity belongs to
implementation design; no public field/schema is introduced here. Stage 5–6
finalizes HTTP mappings/UX. Rate retryAfter is not a promise of overall capacity.

### Accepted measurement-first global capacity plan

**ACCEPTED / FIXED:** choose numerical global rate/burst and backlog settings
from measurements, not arbitrary production defaults. No load tests have run
under this documentation decision. The seven-iteration sequence is unchanged;
measure once the required mechanisms exist and select preliminary thresholds
before production rollout.

- Ambitious normal-load objective: p99 request receipt to provider acceptance
  below one second for requests creating a Delivery. Measure mailbox arrival
  separately, define the tested load envelope, and report denials/failures so
  rejection cannot masquerade as successful low latency.
- Use real PostgreSQL/admission/workers and a controllable fake provider. Ramp
  offered load independently of response latency; compare one/multiple replicas
  and find sustained throughput with no continuing backlog growth.
- Exercise distinct-identity/IP bursts of 10/50/100/500 new Deliveries, plus
  same-challenge concurrency. At the eight/second gate, ideal last-permission
  waits alone are 1.125/6.125/12.375/62.375 seconds; subsecond completion is not
  promised for these bursts.
- Test slow responses, transient/ambiguous failures, Retry-After, outage/recovery,
  and competing notifications/retries. Use experimental capacity thresholds to
  verify exact admission bounds, rollback, retained work, no retry storm, and
  cleanup/recovery progress at full backlog.
- Record admission, worker/gate wait, provider-call and end-to-end latency,
  p95/p99, throughput, backlog size/oldest age, denials, retries, terminal failures,
  closed delivery windows, and recovery drain time. Document environment,
  duration, sample sizes, and privacy-safe telemetry.
- Separately authorize bounded real-Resend/mailbox validation within provider
  quotas; perform bulk/fault tests with the fake provider.
- Select preliminary limits from sustainable auth throughput, competing email
  demand, acceptable user wait, and headroom; validate against pilot traffic.
  Acceptable wait and launch traffic remain inputs to refine. Challenge lifetime
  is not the UX waiting target; throughput times waiting time is only a backlog
  sizing estimate.

Iteration 6 supplies the necessary controls; Iteration 7 executes and records
capacity/fault/concurrency tests. Stage 5–6 HTTP wiring completes measurement
from actual public request receipt; earlier internal tests must identify their
measurement boundary. Production readiness requires selecting and validating
initial settings, without pretending all values were settled in Iteration 1.

### Accepted shared Resend send gate

**ACCEPTED / FIXED V1 starting value:** all application email sends through the
same Resend team share one cross-replica gate of eight permissions per second,
no accumulated burst (minimum 125 milliseconds between permissions; GCRA burst
one). Passwordless initial/resend emails, suspicious-activity/deletion emails,
all retries, legacy sends while retained, and future email scenarios share it.
No per-scenario capacity reservations or priority queues are introduced. Values
stay validated/configurable; new email types do not create extra capacity.

Use a small common mail-infrastructure boundary outside AuthModule: callers
provide recipient, content/template data, and a stable idempotency key. All
application Resend sends must use this boundary. Keep scenario-specific abuse
policies separate. Preserve Stage 3 Delivery/lease/retry ownership without a
second independent auth retry queue; provide reliable deferral for notification
sends instead of dropping direct-send requests when capacity is unavailable.
Concrete interfaces and persistence composition are Iteration 6 work.

The operator confirmed a current Resend ceiling of ten API requests per second
per team, across API keys. The nominal two/second difference is headroom, not
reserved capacity: API reads and external team clients can spend it. Audit all
application send paths before claiming application-wide enforcement; this gate
does not control external team clients.

Iteration 6 integrates distributed submission eligibility with claim/defer,
without consuming processing attempts solely on capacity waiting, holding locks
during I/O, shortening Retry-After, or creating new Deliveries. Verify exact
spacing after idle time and between replicas, all send scenarios/retries sharing
capacity, and new Deliveries retaining cross-Delivery provider restrictions. Crash/permission
accounting, daily/monthly quota exhaustion, and remaining global admission
semantics/thresholds remain open.

### Accepted configuration and analytics requirements

Iteration 2 implementation: six domain GCRA policies, two Delivery
cooldown settings, and the separate public HTTP request GCRA policy now have
required startup validation and configuration snapshots. `.env.example` records
the accepted V1 values. The configuration boundary and coordinated replica
rollout/state-preservation rules are documented in `auth-architecture.md`,
“Iteration 2 configuration boundary and rollout”. This prepares policy inputs;
enforcement and coordinated runtime application remain later implementation.

Another completed Iteration 2 sub-block implements opaque, versioned HMAC bucket
derivation in common infrastructure with an independent validated keyring.
Auth and HTTP owners declare the accepted policy IDs separately. The primitive
returns all retained-version keys, with the active version marked separately;
fixed vectors and unit tests cover policy/characteristic separation, canonical
IP equivalence, and retained-key stability across version addition/promotion.
The exact encoding, key ownership and staged rotation/retirement requirements
are recorded in `auth-architecture.md`, “Bucket key derivation and rotation”.
This is not implementation or database-backed proof of rotation-safe
enforcement: locking, atomic alias charge/mirroring, safe retirement and
coordinated runtime tuning remain Iteration 3/7 integration work.

The final Iteration 2 sub-block adds `GcraRateLimit` through an additive migration,
with exact rational microsecond TAT, policy snapshots and a checked full-recovery
deadline. `AuthenticationRateLimit` cooldown storage is unchanged. Pure bigint
arithmetic covers exact bursts/fractional intervals, eligibility, retry-after,
explicit conservative tuning and latest-TAT alias reconciliation. Persistence
conversion avoids JavaScript number and Decimal arithmetic for TAT. See
`auth-architecture.md`, “Exact GCRA state persistence and arithmetic”.

Database-backed tests use real Prisma and PostgreSQL without service mocks to
verify exact storage, schema rejection of invalid/nonfinite/fractional values,
safe full-recovery boundaries, retained-alias reconciliation, persisted tuning
and multi-write rollback. Migrations were applied from an empty dedicated test
database. This completes Iteration 2 foundations, not concurrent admission,
production key rotation, cleanup workers or HTTP/domain enforcement.

Make thresholds, windows, GCRA rates/burst capacities, and any applicable denial
durations easy to tune via focused,
documented, validated configuration through ConfigService, without modifying
algorithms. A dashboard or live configuration platform is not required. Define
replica rollout and active-window/TAT-debt/denial behavior before implementation; changing
configuration must not inadvertently clear protection.

Provide aggregate metrics and a documented analysis view/query for per-policy
checks, denials, failure charges, verification successes, retry-after waits,
limiter latency/errors/conflicts, and effective configuration version. Keep
triggering failures distinct from denied retries and preserve overlapping-denial
attribution. Use bounded labels without per-identity/IP/bucket identifiers or
proof/secret material. Backend metrics must preserve the tracking-free fallback
contract. Denials alone do not prove false positives; tune with success/load
and support evidence. Telemetry outages do not change enforcement.

### Implementation iterations

1. **Policy semantics — COMPLETE.** Accepted policies and protected resources,
   characteristics, admission/charge conditions, algorithms/values,
   denial/retry-after, failure/transaction semantics, and privacy are consolidated
   in the architecture register. Measurements and implementation details have
   explicit later owners. No new policy decisions are required to start
   Iteration 2; the ten-Delivery reference is not a fixed hourly quota.
2. **Secure/extensible bucket derivation and configuration — COMPLETE.** Derive opaque keys
   from policy identity and canonical characteristics using independent auth
   rate-limit key material. Implement the accepted canonical IP contract and resolve key-rotation semantics
   without changing proxy trust. Active challenge and identity cooldown keys must remain stable and
   cannot be bypassed by rotation. Use existing persistence without a new
   challenge cooldown field or minimum-interval framework. Add centralized,
   validated policy settings/examples, define GCRA TAT persistence, and specify
   replica rollout and active-state semantics for tuning. Prepare reusable
   route-group request policy configuration separately from auth domain policies.
   Delivered strict canonical IP, independent versioned HMAC key derivation,
   validated policy snapshots, exact GCRA persistence/arithmetic and rollout/
   tuning/rotation contracts. Unit and PostgreSQL persistence tests pass;
   runtime enforcement and concurrent alias/cooldown mutations remain Iteration 3.
3. **Atomic PostgreSQL limiter — IN PROGRESS.** The first block supplies
   self-owned, single-policy GCRA unit admission with atomic retained-alias
   locking/reconciliation/charge. Real PostgreSQL tests cover concurrency,
   fresh time after advisory and row waits, denial immutability, rollback,
   confirmed-abort retries and fail-closed infrastructure errors. The exact
   contract and operational settings are in `auth-architecture.md`, “Iteration 3
   single-policy atomic GCRA admission”. Cooldown and a complete multi-policy
   atomic boundary remain pending; HTTP/domain enforcement is not connected.
   Use locking or Serializable equivalents,
   deterministic lock ordering, bounded retries, and fresh DB-authoritative
   time. Enforce exact multi-replica admission with persisted retry-after.
   Implement admission-anchored count=1/windowEndAt cooldown, not calendar-aligned
   1/60s, including cross-challenge serialization for the same identity.
   Distinguish policy denial from infrastructure failure and do not allow
   auth to proceed without authoritative protection. Test concurrent admission
   and boundary behavior against PostgreSQL. Implement atomic GCRA eligibility
   and TAT updates with exact burst and subsecond rate arithmetic; keep this
   separate from admission-anchored cooldown counters.
4. **Delivery admission and cooldown.** Introduce the common next-Delivery path
   and transaction-composable resend persistence. Check lifecycle, Delivery
   window, cooldown, and applicable policies before new-admission mutation.
   Resolve existing unfinished work without replacement, charge, or cooldown
   movement. Enforce at most one unfinished Delivery per challenge, including
   concurrent requests. Atomically charge, create new work, and establish cooldown. Denial preserves existing work. Cover initial/resend concurrency,
   exactly-at-boundary eligibility, rollback, closed Delivery window, and provider
   results that do not modify cooldown. Include expiry replacement with the
   same email, 00:06 Resend returning 54 seconds after a 00:00 admission, concurrent
   admissions across different challenges, and atomic replacement rollback.
5. **Verification admission.** Keep abuse budgets conceptually separate from
   proof failure accounting, but compose admission, proof comparison, and result
   mutations in one short PostgreSQL transaction. Serialize challenge and all
   four buckets in deterministic order; obtain fresh DB time after required
   waits. Require all four policies to allow before proof comparison. Commit a
   canonical mismatch as a result value with all four failure charges; map the
   HTTP error after commit. Success/excluded outcomes/denial do not advance TAT.
   Technical failure rolls back all verification-transaction changes, while
   separately committed request accounting remains. Preserve Stage 2 atomic
   consumption and explicitly classified business-outcome commit semantics.
   Test partial-charge rollback, competing challenges sharing identity/IP,
   concurrent success, and committed mismatch with a lost HTTP response. Enforce the accepted
   verification-only mitigation boundary and test that it does not itself deny
   request/resend or mutate account/challenge state. Verify applicable abuse
   state survives challenge replacement. Cover the accepted failure/outcome
   matrix, including fifth/later failure charge without target lock and
   exclusions that still require request protection. HTTP integration stays in
   Stage 6. Cover GCRA bursts of 6/72, respective sustained rates, idle and
   partial recovery, exact eligibility, retry-after rounding, concurrency, and
   success/denial not changing TAT. Verify challenge replacement retains debt,
   short-term recovery does not unlock challenges/reset long-term state, and
   cleanup cannot restore burst prematurely. Deliver the gated Stage 2/3 OTP-
   lock transition: failures do not clear proof/cancel Delivery, GCRA denial
   resumes on the same live challenge, and expiry/single-use/fail-closed behavior
   remains enforced. Do not remove legacy protection before these checks pass.
6. **Global/provider pressure.** Separate aggregate admission of new Deliveries
   from actual provider submission capacity, including retries. Enforce the
   accepted auth backlog model atomically with admission, counting all PENDING/PROCESSING
   work across replicas and reserving capacity for new admissions. Enforce the
   accepted shared eight/second cross-replica send gate without accumulated burst
   through common mail infrastructure, covering all application send callers
   and retries. Add reliable notification deferral while preserving Stage 3 retry
   ownership; do not duplicate auth retry queues. Respect the confirmed team
   ceiling. Supersession and
   a new Delivery/idempotency key must not bypass applicable cross-Delivery
   Retry-After/global provider-pressure restrictions. Capacity waiting must not
   silently spend Stage 3 processing attempts, create another Delivery, alter
   proof, or fabricate provider failure. Preserve leases, idempotency, retry
   scheduling, and recovery. No distributed semaphore without a separate decision.
7. **Cleanup and full integration verification.** Preserve active cooldown state
   until its applicability ends, independently of Delivery retention. Verify
   multi-replica concurrency, denial immutability, rollback, rotation safety,
   lifecycle/window boundaries, and cross-Delivery provider restrictions with
   real PostgreSQL services. Run applicable repository checks; HTTP coverage is
   completed when Stage 5–6 endpoints are connected. Deliver operational metrics
   and documented analysis queries/views, validate safe labels and denial
   attribution, and verify configuration changes preserve agreed active-state
   semantics and telemetry failure does not affect enforcement.

## Stage 5: Request and resend endpoints

Implement:

```text
POST /auth/challenges
POST /auth/challenges/:challengeId/resend
```

Requirements:

- normalize and validate institutional email at the HTTP boundary;
- require active `AllowedDomain`;
- do not create a user;
- serialize active challenge resolution for identity and purpose;
- return a reusable live challenge for the same identity/purpose without
  automatically creating another Delivery or charging Delivery quota/cooldown;
- admit a new challenge's initial Delivery and explicit resend only when policy
  permits; every next-Delivery path uses the shared admission boundary;
- Request new code after expiry must respect the remaining identity
  interval rather than start a new wait or bypass it with a new challenge;
- derive explicit resend recipient from authoritative challenge identity;
- return remaining, not reset, expiry;
- preserve identical response shape across new, active, blocked, and
  deletion-scheduled identities;
- expose enough authoritative state to represent remaining resend cooldown,
  without resetting it on challenge reuse; use one retry-after value in body and
  `Retry-After` on 429;
- finalize HTTP response/error behavior for Delivery-window and admission
  outcomes without conflating Delivery eligibility and proof lifetime.

Database-backed e2e tests must include simultaneous initial requests and
simultaneous resends, repeated initial resolution without extra Deliveries,
and unchanged cooldown/Delivery state after denial.

## Stage 6: OTP and magic-link verification

Implement:

```text
POST /auth/challenges/:challengeId/verify-otp
POST /auth/challenges/:challengeId/verify-link
```

Both endpoints converge on one verification orchestration and one conditional
consume state. Opening a magic-link `GET` does not consume proof.

Inside one transaction:

1. lock/recheck challenge state and purpose;
2. verify proof or atomically record an OTP failure;
3. consume valid proof;
4. resolve account state;
5. create or activate the same `User.id` where permitted;
6. create a session with method and authentication time;
7. record security events.

After commit, distinguish newly created accounts from existing-account sign-ins.
Registration records the session event but generates no new-session alert; its
welcome message is separate onboarding. Subsequent sign-ins use the Stage 9
in-app/push notification policy, without new-session email. Notification delivery
failure must not roll back authentication. Coordinate retirement of the existing
email path with Stage 9/11 readiness.

Required database-backed tests:

- new identity creates one active user and one session;
- active identity creates an independent session;
- transitional pending identity keeps the same user ID;
- blocked identity receives no session;
- deletion-scheduled identity receives only a cancellation continuation;
- OTP consumption invalidates link and link consumption invalidates OTP;
- wrong-code attempts governed by GCRA without attempt-count lock; denial and
  retry on the same live challenge, with proof/Delivery state preserved;
- expired, consumed, and replayed proof;
- concurrent OTP/link verification creates at most one session;
- repeated valid-link clicks and concurrent POST losers do not change any of
  the four verification failure TATs; success and consumed/expired replays are
  not proof mismatches, while repeated canonical wrong tokens for live eligible
  challenges remain chargeable; independent HTTP request accounting still applies;
- client duplicate in-flight submissions/retry loops are prevented and GET/
  preview requests never trigger POST verification or consume proof;
- no raw proof appears in persisted records.

## Stage 7: Enforce the strict active-session limit

Keep `SESSION_ACTIVE_LIMIT = 10` as a strict hard limit. If successful proof is
consumed while ten active sessions already exist:

- create no new, temporary, or overflow session;
- expose no active-session list to the new client;
- grant no session-revocation authority;
- return `SESSION_LIMIT_REACHED` with `activeSessionLimit` only;
- keep the challenge consumed.

The user must revoke a session from an already authorized device and then
complete a new sign-in challenge. Recovery when every authorized device is
inaccessible is deferred to V2, when additional authenticators and recovery
methods exist. Database-backed concurrency tests must prove the hard limit can
never be exceeded.

### Accepted V1 earlier-session targeted revoke exception

Implement the accepted target policy from auth-architecture.md: an active,
authorized session still within management cooldown may revoke an owned active
target only when the target's persisted createdAt is strictly later than the
actor's. Equal/earlier targets retain SESSION_TOO_FRESH. Preserve self-revocation
and mature-session behavior. Do not relax rename/revoke-others cooldowns or the
strict active-session limit. Validate actor/target authorization and mutate
atomically; notification/push payloads do not grant authority.

This accepts the residual risk of an attacker holding the earlier session;
chronology is not owner proof. Add focused service and database-backed HTTP/
concurrency coverage, including A at zero revoking B at +30 seconds, reverse
order/tie denial, ownership/active state and concurrent actor revocation, and
immediate protected-access/refresh rejection after committed target revocation.
Current runtime remains unchanged until this focused session-management work.
Stage 9 notification actions and Stage 11 mobile UX use the authenticated
selected-revocation endpoint rather than creating a separate authority path.

## Stage 8: Recent authentication and account deletion

Store `authenticationMethod` and `authenticatedAt` on every created session.
Requesting deletion requires authentication within the approved 600-second
window. An older session completes a `STEP_UP` challenge through the dedicated
request and OTP/link verification endpoints. The challenge is bound to the
active user and session, uses the account's institutional email, and cannot be
redirected to a client-selected address. Successful proof refreshes the
existing session's recent-auth record without creating or rotating a session.

Replace password cancellation with:

```text
SIGN_IN proof for a deletion-scheduled account
→ single-use ACCOUNT_DELETION_CANCEL continuation
→ explicit POST /account/deletion/cancel
→ ACTIVE plus one new Session
```

Deletion invalidates active challenges and continuations, revokes all sessions,
and keeps external notification work after commit. Normal sign-in never
silently cancels deletion.

Update finalization to remove challenge, delivery, continuation, and future
credential data according to retention and anonymization rules.

## Stage 9: Security events, risk, and notifications

Replace password-specific terminology and events with challenge/proof events:

```text
AUTH_CHALLENGE_REQUESTED
AUTH_CHALLENGE_DELIVERY_FAILED
AUTH_CHALLENGE_VERIFIED
AUTH_CHALLENGE_FAILED
AUTH_CHALLENGE_REPLAYED
STEP_UP_SUCCEEDED
STEP_UP_FAILED
```

Implement the accepted notification-channel target:

- New-account registration: one OTP/magic-link email without resend; no
  new-session alert. Persist a separate welcome message in the Unicon system
  conversation after account creation.
- Subsequent existing-account sign-ins: in-app new-session message in the same
  conversation and push to eligible previous devices; no new-session email,
  even if there are no previous active sessions or push recipients.
- Suspicious activity: in-app message in that conversation, push, and email,
  with deduplication/admission that prevents alert bombing.
- Account-deletion requested, cancelled, and completed: retain email.

Persist in-app messages independently of push outcomes. Push cannot override OS
permissions or guarantee display. Keep notification failures outside the
successful authentication transaction. Replace the current new-session email
path only when durable in-app and Stage 11 push/mobile integration are ready;
this does not require building a general-purpose chat system.

Connect actionable new-session notification UX to authenticated session details
and the Stage 7 targeted-revoke policy. “This was not me” revokes the selected
session only if the actor is authorized; “This was me” is acknowledgment, not
new proof or a permission upgrade. Notifications do not introduce a mandatory
approval step for otherwise valid new sessions.

Keep session and account-deletion events. Risk signals use failed proof rather
than failed password login. Risk remains observational and notification-only
until production false-positive evidence supports stronger action.

Remove password-change and password-reset notification types, templates,
events, and idempotency paths. Rewrite account-deletion messaging without
password instructions.

## Stage 10: Remove legacy password runtime

Remove:

- `/auth/register`, `/auth/login`, `/auth/verify-email`, and resend-verification;
- forgot/reset-password endpoints and services;
- `/account/password`;
- password fields from deletion DTOs;
- `PasswordModule`, `PasswordService`, validation constants, and bcrypt;
- password-specific environment variables, public errors, Swagger, tests, and
  documentation.

Do not keep dormant legacy routes behind an undocumented flag. Optional
password is a future specialized authenticator, not the old mandatory flow.

## Stage 11: Stable OpenAPI and mobile integration

- Generate explicit request, success, and error DTOs for every public endpoint.
- Verify removed password endpoints are absent from OpenAPI.
- Document device metadata, challenge selector, OTP, link secret, and
  continuation as distinct concepts.
- Implement iOS one-time-code input and Universal Links.
- Implement Android autofill/paste UX and App Links.
- Test cold start, warm start, installed/uninstalled app, another-device link,
  expired link, scanner prefetch, and HTTPS fallback behavior.
- Keep `/profile/me` as the authoritative onboarding bootstrap.
- Integrate the shared Unicon system conversation for welcome, new-session, and
  suspicious-activity messages, plus eligible-device push registration/delivery.
  Registration has no new-session alert; later sign-ins have no new-session email.
- Implement “This was me” / “This was not me” UX using authenticated session
  details and Stage 7 targeted revocation; push payloads grant no authority.
- Verify disabled/unavailable push still leaves the persisted in-app message
  accessible and does not prevent authentication.

## Stage 12: Production hardening and handoff

- Verify real email delivery, duplicate/delayed mail behavior, and provider
  idempotency.
- Monitor request, delivery, resend, verification, lock, expiry, and completion
  rates without logging proof.
- Configure exact proxy trust, CORS, security headers, secret management,
  structured logs, backups, and cleanup scheduling.
- Run build, lint, unit tests, database-backed e2e tests, Prisma validation, and
  migration status checks.
- Audit generated OpenAPI and representative responses for internal-field
  leakage.

## V2: extensible authenticators and delivery

V2 may add:

- verified personal recovery email;
- optional `PasswordCredential`;
- passkey/WebAuthn credentials and ceremonies;
- `IN_APP` delivery to an already authorized session;
- optional push delivery.

These features produce the same credential-neutral authenticated principal and
enter the same session layer. Password never returns as a mandatory
`User.passwordHash`. Passkeys keep WebAuthn-specific credential and challenge
models. Delivery channels remain distinct from proof methods.

Account linking always starts from an authenticated existing `User.id`,
requires recent authentication, independently verifies the new method, and
never relies on email equality.

## Explicitly excluded from v1

- Password authentication and password recovery.
- Passkeys and TOTP.
- OAuth or social login.
- Personal-email recovery.
- In-app or push challenge delivery.
- Silent session eviction.
- Automatic account blocking from device metadata or GeoIP.
- Authentication or account linking based only on matching email strings.
