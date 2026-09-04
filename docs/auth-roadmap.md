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
- clearing encrypted proof when a challenge becomes terminal;
- fixed challenge lifetime;
- purpose validation;
- atomic failed-attempt increment and lock;
- atomic consume shared by OTP and magic link;
- expired challenge cleanup.

Raw, hashed, or encrypted proofs never enter logs or security events. HMAC and
encryption keys are independent from each other and from JWT and rate-limit
secrets, and are validated at startup.

Required unit tests include format, entropy source boundaries, hash binding,
wrong purpose, expiry, fifth-attempt lock, replay, and concurrent consumption.

## Stage 3: Delivery abstraction and email

Implement provider-neutral challenge delivery:

```text
challenge proof
→ AuthenticationChallengeDelivery
→ EMAIL adapter
→ provider result
```

One challenge keeps one OTP and link. Initial request and every resend create a
new Delivery containing the same proof. Provider retries reuse one delivery and
its idempotency key.

Email requirements:

- code prominently in subject and body for mobile notification/AutoFill UX;
- magic-link Universal Link/App Link plus HTTPS fallback;
- no account-state disclosure;
- no raw proof in application logs or persisted provider errors;
- fixed challenge expiry wording;
- failure recorded without consuming, resetting, unlocking, or extending the
  challenge.

Required tests cover successful delivery, synchronous failure, provider retry,
user resend, idempotency, stable proof across deliveries, and retention.

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
