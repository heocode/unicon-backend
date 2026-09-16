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
maximum failed OTP attempts:  5
resend cooldown:              60 seconds
recent-authentication window: 600 seconds
v1 delivery methods:          EMAIL
v1 proof methods:             OTP, MAGIC_LINK
```

V1 has no password, passkey, OAuth, personal recovery email, in-app delivery,
or push delivery. Loss of the institutional mailbox has no self-service
recovery in v1. Personal recovery email is planned separately.

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
- atomic failed-attempt increment and lock;
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
wrong purpose, expiry, fifth-attempt lock, replay, and concurrent consumption.

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
   delivery protocol.

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

One challenge keeps one OTP and link. Initial request and every resend create a
new Delivery referencing the same proof, with explicit `INITIAL` or `RESEND`
origin and a new idempotency key. A provider retry reuses the same Delivery,
delivery ID, and idempotency key. It never becomes a resend.

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
lock, expiration, attempt exhaustion, and complete-envelope state. An in-flight
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

Manual resend preserves the challenge, proof, expiration, and attempt state,
creates a new `RESEND` Delivery and idempotency key, and atomically cancels
prior non-terminal Deliveries as `SUPERSEDED_BY_RESEND`. A superseded worker
loses mutation ownership and cannot mark sent, schedule retry, mark failed, or
perform another Delivery mutation. This guarantees database ownership, not
physical cancellation: an already-submitted provider request may still
complete, so two messages containing the same proof are an accepted UX race.

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

Implement keyed, database-backed rate limits before account lookup for:

- identity delivery requests;
- IP delivery requests;
- optional app-install/device bucket;
- verification per challenge, identity, and IP;
- resend cooldown;
- global/provider pressure.

Initial policy targets are five deliveries per identity per hour, twenty per
IP per hour, and twenty verification attempts per IP per fifteen minutes. The
per-challenge limit remains five failed OTPs.

Serializable transactions or equivalent locking must make limits consistent
across replicas and concurrent requests. Raw email and IP bucket inputs are not
stored.

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
- reuse one active challenge rather than rotate proof;
- create a new Delivery only when policy permits;
- return remaining, not reset, expiry;
- preserve identical response shape across new, active, blocked, and
  deletion-scheduled identities;
- expose authoritative cooldown in body and `Retry-After` on 429.

Database-backed e2e tests must include simultaneous initial requests and
simultaneous resends.

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

After commit, dispatch the existing best-effort new-session notification.

Required database-backed tests:

- new identity creates one active user and one session;
- active identity creates an independent session;
- transitional pending identity keeps the same user ID;
- blocked identity receives no session;
- deletion-scheduled identity receives only a cancellation continuation;
- OTP consumption invalidates link and link consumption invalidates OTP;
- wrong-code attempts and fifth-attempt lock;
- expired, consumed, and replayed proof;
- concurrent OTP/link verification creates at most one session;
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
AUTH_CHALLENGE_LOCKED
AUTH_CHALLENGE_REPLAYED
STEP_UP_SUCCEEDED
STEP_UP_FAILED
```

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
