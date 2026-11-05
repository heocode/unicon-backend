# Passwordless Auth Architecture

This document defines the approved target architecture for Unicon
authentication. The passwordless implementation is not complete until the
roadmap stages and database-backed tests described here have been delivered.
The current password endpoints are transitional implementation details and
must not shape new product code.

## Product decision

Unicon v1 authenticates only through an institutional email whose domain is
present in `AllowedDomain` and active. Registration and returning sign-in are
one flow:

```text
institutional email
→ AuthenticationChallenge
→ EMAIL Delivery containing one OTP and one magic link
→ OTP or magic-link proof
→ atomic challenge consumption
→ resolve or create User
→ create Session
→ issue access and refresh tokens
```

There is no password, passkey, OAuth, or separate registration flow in v1.
The stable application identity remains `User.id`. Email, affiliation, and
authentication methods may change without changing ownership of profile or
other product data.

The approved v1 parameters are:

```text
OTP format:                    six decimal digits
challenge lifetime:           600 seconds
maximum failed OTP attempts:  5
next-Delivery minimum interval: 60 seconds
recent-authentication window: 600 seconds
delivery methods:             EMAIL
proof methods:                OTP, MAGIC_LINK
```

All durations and limits are validated environment configuration. They must
not be duplicated as hardcoded service constants.

## Identity and account creation

An authentication request does not create a `PENDING` user. Pending proof
belongs to `AuthenticationChallenge`. A new `User` is created only after
successful proof of an active allowed institutional email, and is created as
`ACTIVE` with `emailVerified = true`.

The successful proof path resolves account state as follows:

- no user owns the normalized email: create a new `ACTIVE` user and its first
  session;
- `ACTIVE`: create an independent new session;
- transitional `PENDING`: activate the same `User.id`, preserving any related
  data, then create a session;
- `BLOCKED`: consume or terminally resolve the proof but issue no session and
  return `ACCOUNT_UNAVAILABLE`;
- `DELETION_SCHEDULED`: do not silently cancel deletion; return a short-lived,
  purpose-bound continuation for an explicit cancellation flow;
- `DELETED`: the tombstone does not own its former institutional email, so the
  address may create a new, unrelated `User.id` after fresh verification.

Account state is not disclosed before valid proof. Matching an email string is
never sufficient to merge, restore, or link accounts.

## AuthenticationChallenge

One challenge owns one stable proof set for its complete lifetime:

```text
AuthenticationChallenge
├── id
├── identityType
├── normalizedIdentity
├── purpose
├── userId?
├── otpHash
├── linkTokenHash
├── hashProtocolVersion
├── hashKeyVersion
├── encryptedProof
├── encryptionProtocolVersion
├── encryptionKeyVersion
├── expiresAt
├── failedAttemptCount
├── maxAttempts
├── consumedAt?
├── lockedAt?
├── createdAt
├── updatedAt
└── deliveries[]
```

Initial purposes are:

```text
SIGN_IN
STEP_UP
```

Purpose separation is an authorization boundary. A `SIGN_IN` proof cannot
directly mutate deletion or authorize an unrelated sensitive operation. For a
deletion-scheduled account it may issue a separate, explicit, purpose-bound
cancellation continuation after proof; the sign-in challenge itself never
cancels deletion.

The challenge is usable only while all of these are true:

```text
consumedAt = null
lockedAt = null
expiresAt > now
failedAttemptCount < maxAttempts
```

Expiration is fixed when the challenge is created. Delivery retries never
extend it. Terminal challenges are retained only for the configured short
operational and security period, then deleted.

### Stable proof invariant

The OTP and magic-link token never change during the lifetime of a challenge.
Every email delivery for that challenge contains the same code and link.
This prevents delayed or duplicated email from presenting a valid-looking but
superseded code.

OTP and magic link share one `consumedAt`. Successful use of either proof
invalidates both. Raw OTPs and link tokens are never persisted or logged.

Stable resend requires the server to reproduce the original proof. A one-way
hash alone cannot do that. The challenge therefore stores two independent
representations:

- keyed hashes used only for proof verification;
- an authenticated-encryption envelope containing the OTP and link secret,
  used only to render a Delivery.

The envelope uses a versioned encryption key and authenticated encryption such
as AES-256-GCM. Its nonce and authentication tag are stored with the ciphertext.
Plaintext exists only in bounded process memory during creation or delivery and
is never written to logs, events, delivery rows, or provider-error records.
Encrypted proof is cleared when the challenge becomes consumed, locked, or
expired and no further delivery is permitted.

Proof generation returns an explicit persistence/transient boundary:

```text
GeneratedChallengeProof
├── persistence: ChallengeProofPersistenceData
│   ├── hashing: HashedChallengeProofData
│   │   ├── otpHash
│   │   ├── linkTokenHash
│   │   ├── hashProtocolVersion
│   │   └── hashKeyVersion
│   └── encryption: EncryptedChallengeProofData
│       ├── encryptedProof
│       ├── proofEncryptionIv
│       ├── proofEncryptionTag
│       ├── encryptionProtocolVersion
│       └── encryptionKeyVersion
└── deliveryProof: TransientChallengeDeliveryProof
    ├── otp
    └── linkToken
```

Only `ChallengeProofPersistenceData` may be passed to Prisma. The transient
delivery proof exists only in bounded process memory while constructing a
Delivery and must never be serialized into logs, errors, events, or database
records.

Encryption is independently versioned. Protocol v1 is immutable and uses
AES-256-GCM with a 32-byte key, random 12-byte IV, and 16-byte authentication
tag. Its length-prefixed plaintext fields are the UTF-8 domain
`unicon.auth.challenge.envelope.payload.v1`, the six ASCII OTP bytes, and the
32 raw magic-link secret bytes. Its length-prefixed additional authenticated
data fields are the UTF-8 domain
`unicon.auth.challenge.envelope.aad.v1`, purpose, canonical challenge ID, and
normalized identity, in that order.

`encryptionProtocolVersion` dispatches to the protocol implementation before
decryption; the selected implementation then constructs its AAD. It is
independent from `encryptionKeyVersion`. Unsupported protocol or unavailable
key versions are configuration/data-invariant failures. A GCM authentication
failure or malformed decrypted payload is a corrupted-proof failure. Public
HTTP handling may mask both as a generic internal failure, but backend
diagnostics preserve the category without recording proof or key material.

The encryption service accepts only `EncryptedChallengeProofData`, never the
hashing persistence fields. Active hash and encryption versions and keys are
each captured once within their respective generation call. This prevents a
single proof set from mixing key versions during rotation.

Ciphertext, IV, and tag are either all present or all absent. When present,
ciphertext is non-empty and IV/tag have the protocol-v1 lengths. Protocol and
key versions are always positive, non-null audit metadata. Terminal cleanup
clears only ciphertext, IV, and tag; it preserves both version fields.

Expired proof is also cleared proactively when no verification request arrives.
Cleanup processes bounded PostgreSQL batches selected with
`FOR UPDATE SKIP LOCKED`; selection and mutation remain in one short
transaction. A batch uses one database `clock_timestamp()` and never loads
proof material into application memory. The database all-present-or-all-null
envelope constraint is a required invariant, not something cleanup silently
repairs.

Retention deletion uses the immutable `retentionExpiresAt` saved on each
challenge. This preserves the lifecycle assigned at creation even if the
configured retention changes later. Deleting a retained challenge cascades to
its Delivery rows. Cleanup alternates envelope clearing and retention deletion
under one configurable per-run batch budget so neither phase can starve the
other. Empty database checks consume that budget, overlapping runs in one
process are skipped, and multiple application instances safely divide work
through `SKIP LOCKED`. A failed batch rolls back independently; earlier batches
remain committed and a later scheduled run retries the remaining work.

## Delivery model

Delivery and proof are separate concepts:

```text
delivery methods: EMAIL, future IN_APP, future PUSH
proof methods:    OTP, MAGIC_LINK, future PASSWORD, future PASSKEY
```

V1 uses only `EMAIL` delivery. A resend creates a new delivery for the existing
challenge:

```text
AuthenticationChallengeDelivery
├── id
├── challengeId
├── method
├── origin
├── status
├── recipientSnapshot
├── idempotencyKey
├── templateProtocolVersion
├── attemptCount
├── nextAttemptAt?
├── processingLeaseId?
├── processingLeaseExpiresAt?
├── providerMessageId?
├── lastSafeFailureCode?
├── attemptedAt?
├── sentAt?
├── retentionExpiresAt
├── createdAt
└── updatedAt
```

A delivery never stores proof material, including encrypted proof. It records
an attempt to transmit proof recovered transiently from its challenge.

Resend preserves:

- challenge ID;
- OTP and magic-link token;
- `expiresAt`;
- `failedAttemptCount`;
- `consumedAt` and `lockedAt`;
- challenge, identity, IP, and delivery rate-limit state.

Delivery origin is explicit: an initial request creates an `INITIAL` Delivery
and a user-requested resend creates a `RESEND` Delivery. Each has a different
delivery ID and idempotency key. Retrying the provider for either one is not a
new Delivery and always reuses its original delivery ID and idempotency key.
An admitted Delivery remains charged even if provider processing fails.
Challenge- and identity-scoped cooldowns are anchored to successful Delivery admission, not
provider acceptance; see the accepted next-Delivery minimum interval below.
Request abuse, Delivery quota, and provider submission accounting remain
separate costs.

Delivery processing has five states:

```text
PENDING
  → PROCESSING

PROCESSING
  → SENT
  → PENDING for a scheduled retry
  → FAILED
  → CANCELLED
  → PROCESSING under a new lease after the previous lease expires

SENT, FAILED, and CANCELLED are terminal
```

Claiming a Delivery atomically creates a unique UUID `processingLeaseId`, sets
`processingLeaseExpiresAt`, and increments `attemptCount`. The counter is an
operational fail-safe work budget for processing claims and reclaims, not a
claim that the provider received each request. Every worker-owned sent, retry,
failed, or cancelled transition from processing must match both
`status = PROCESSING` and the supplied lease ID. A serialized challenge
lifecycle transition such as resend supersession may instead revoke the lease
atomically without pretending to own it. In either case, a stale worker cannot
overwrite the later state. Lease fields are present only while processing and
are cleared by a successful state transition.

The provider call is never made inside a database transaction. Before each
submission the current lease owner checks that the challenge exists, remains
unconsumed and unlocked, has not expired or exhausted its OTP attempts, and
still owns a complete encrypted envelope. It then decrypts and renders proof
only in bounded memory before calling the provider. If the challenge becomes
terminal after this check, the in-flight email may still be accepted; its OTP
and link remain unusable because verification rechecks challenge state. No
distributed transaction between PostgreSQL and the provider is attempted.

The database all-present-or-all-null envelope constraint remains authoritative.
A partial envelope is an internal data-integrity failure: delivery does not
repair it, treat it as a normal provider failure, or silently mark it failed.

Provider adapters normalize results as accepted, retryable, or terminal.
Retryable results distinguish `SAFE_RETRY`, where the adapter knows the
provider did not accept the request, from `AMBIGUOUS_RETRY`, where acceptance
is unknown after a timeout, connection loss, unknown response, or Resend 5xx.
V1 treats only an explicit rate-limit rejection as proven `SAFE_RETRY`; it does
not assume that every 5xx means the provider rejected submission. A provider
retry hint may influence `nextAttemptAt`. Raw provider errors and responses are never persisted;
only an allowlisted safe failure code may be stored. `FAILED` means a terminal
provider, request, or configuration failure. `CANCELLED` means proof must no
longer be delivered; initial safe cancellation reasons include
`DELIVERY_WINDOW_CLOSED`, `CHALLENGE_UNAVAILABLE`, and
`SUPERSEDED_BY_RESEND`. A partial envelope remains an internal data-integrity
failure and does not enter either ordinary terminal flow.

`attemptedAt` records the latest processing claim; `attemptCount` remains the
fail-safe claim/reclaim budget rather than an exact HTTP submission count. In
V1 the ten-minute challenge lifetime is strictly shorter than Resend's
24-hour idempotency window, so every otherwise eligible ambiguous retry is
inside that window by construction. Startup configuration enforces this
assumption; orchestration does not perform a separate runtime window check.

One Delivery also fixes an immutable `templateProtocolVersion`. Immutable
email content consists only of recipient, From, subject, HTML, plain text, and
versioned CID attachment metadata and bytes.
Operational submission context separately carries `deliveryId`,
`idempotencyKey`, and `templateProtocolVersion`; these fields are not email
body or provider payload fields. No generic provider request-options bag is
part of the V1 contract. Every retry reproduces deterministic
application-level email content and the same idempotency key. Rendering uses
the persisted template protocol rather than the current
deployment default and contains no render-time clock values, random IDs,
tracking parameters, unstable whitespace, or other dynamic input. Changing a
template defines a new protocol version; it never changes an existing
Delivery's payload.

### V1 delivery retry policy

The approved V1 policy is:

```text
MAX_DELIVERY_PROCESSING_ATTEMPTS = 5

attempt 1: immediately
attempt 2: 5 seconds after the previous attempt completes
attempt 3: 15 seconds after the previous attempt completes
attempt 4: 30 seconds after the previous attempt completes
attempt 5: 60 seconds after the previous attempt completes

JITTER = uniform [0.8, 1.2]
HTTP_TIMEOUT = 10 seconds
PROCESSING_LEASE_TIMEOUT = 45 seconds
MIN_DELIVERY_VALIDITY_REMAINING = 120 seconds
RESEND_IDEMPOTENCY_WINDOW = 24 hours
```

Because `attemptCount` is incremented by claim, retry selection uses this exact
mapping rather than direct array indexing:

```text
after processing attemptCount = 1 → retry delay 5 seconds
after processing attemptCount = 2 → retry delay 15 seconds
after processing attemptCount = 3 → retry delay 30 seconds
after processing attemptCount = 4 → retry delay 60 seconds
after processing attemptCount = 5 → no retry; budget exhausted
```

This mapping is an explicit protocol rule and requires an exact unit test to
prevent an off-by-one error.

Jitter applies only to policy backoff, never to the immediate attempt. It is
computed once while scheduling a retry, uses an injectable random source for
deterministic tests, and is persisted through `nextAttemptAt`; a later claim
never recalculates it. Retry delay begins after completion of the preceding
processing attempt.

A normalized provider `Retry-After` produces:

```text
effectiveNotBefore = max(
  operationNow + jitteredPolicyDelay,
  operationNow + providerRetryAfter
)
```

The Resend adapter parses only the HTTP `Retry-After` contract exposed in its
response headers: integer delta-seconds or an IMF-fixdate HTTP-date. Malformed
values are ignored. The adapter never shortens a valid provider delay.

The provider delay is never shortened by an application upper bound. If it
would move submission outside the delivery window, retry is cancelled rather
than sent early. Scheduling requires
`expiresAt - nextAttemptAt >= 120 seconds`; submission independently rechecks
`expiresAt - operationNow >= 120 seconds`.

`SAFE_RETRY` and `AMBIGUOUS_RETRY` share the same five-processing-attempt
budget. An ambiguous retry additionally requires the same Delivery,
idempotency key, deterministic application-level payload, and active
challenge. Final MIME boundaries, Date, Message-ID, and provider-added headers
are outside the application's deterministic contract. A permanent recipient
rejection, invalid provider request, provider configuration error, or API authentication error fails
without retry and produces an internal operational alert where appropriate.

An expired processing lease with `attemptCount < 5` may be reclaimed with a
new lease and incremented count. At `attemptCount >= 5`, it is atomically made
terminal and its lease is cleared instead of granting a sixth claim. If proof
is already unavailable it becomes `CANCELLED`; otherwise it becomes `FAILED`
with the allowlisted `PROCESSING_ATTEMPTS_EXHAUSTED` reason.

Workers claim due or expired-lease deliveries in short PostgreSQL transactions
without filtering out terminal challenges or absent proof envelopes. Fresh
challenge validation in orchestration is authoritative: unavailable proof
cancels the owned Delivery, while invalid envelope state is an internal
invariant failure. Filtering those rows out of claim would strand PENDING
Deliveries outside terminalization and Delivery retention. Exhausted PENDING
rows are terminalized by the same bounded maintenance operation as exhausted
expired leases; neither can receive a sixth claim.
Workers select candidates
using `FOR UPDATE SKIP LOCKED`. Fair deterministic ordering uses eligibility
time first: initial pending `createdAt`, scheduled retry `nextAttemptAt`, or
expired processing `processingLeaseExpiresAt`; ties use `createdAt` and `id`.
Each free processing lane performs `claim → orchestrate → claim`; workers never
pre-claim a batch into a local leased queue. V1 uses a one-second interval,
four lanes per replica, and at most twenty claims per cycle. Effective provider
concurrency is therefore replica count multiplied by four; deployment must
respect provider throughput because V1 has no distributed global semaphore.
Processing is non-overlapping inside one process and allowed to finish during
graceful shutdown. An exception escaping classified orchestration is unexpected:
the worker records only safe telemetry and leaves the row to lease-expiry
recovery. Delivery retention uses bounded cleanup independent from provider
processing.

Delivery failure never consumes, unlocks, resets, or extends the challenge.

### Manual resend and supersession

A manual resend never creates or rotates an `AuthenticationChallenge`. It
preserves the same OTP, magic-link token, `expiresAt`, failed-attempt count,
consumption, and lock state, while creating a new `RESEND` Delivery with a new
delivery ID and idempotency key. Only a new sign-in request after the prior
flow finishes or expires may create a new challenge under Stage 5 rules.

After successful next-Delivery admission, creating a `RESEND` Delivery
atomically cancels previous `PENDING` and `PROCESSING` Deliveries for that
challenge with `SUPERSEDED_BY_RESEND` and clears their leases. An old worker therefore loses ownership and cannot later finalize its
Delivery. It must recheck delivery ownership and challenge eligibility
immediately before provider submission, without holding a database lock during
the network call.

Superseding a processing Delivery guarantees database ownership semantics, not
cancellation of an external side effect. The transition may set the old row to
`CANCELLED / SUPERSEDED_BY_RESEND` and revoke its current lease, after which
the stale worker cannot call `markSent`, `scheduleRetry`, `markFailed`, or
otherwise mutate that Delivery. A provider request that was already submitted
cannot necessarily be physically cancelled and may still deliver the old
email. The provider may therefore accept both the old and new message. Both
contain the same challenge proof and fixed expiration, making this rare
duplicate an accepted UX race rather than a security issue.

### Stage 3 decision log

Decision 1 is approved. `https://uniconnection.app` is the client-neutral
public origin for authentication links. It is not a mobile-specific auth
domain and the same route may naturally support web authentication later. The
canonical email link is:

```text
https://uniconnection.app/auth/verify?challengeId=<canonical UUID>&token=<canonical magic-link token>
```

Backend configuration exposes this route as
`AUTH_MAGIC_LINK_PUBLIC_URL=https://uniconnection.app/auth/verify`. The value
is an exact protocol constant: variants such as `/auth/verify/`, another host
or scheme, or a URL containing query or fragment data fail startup validation.
The backend does not silently normalize this value.

`/auth/verify` expresses authentication intent rather than an application
destination. Mobile registers it as an iOS Universal Link and Android App
Link. Its `GET` handler only opens a native client or safe HTTPS fallback; it
never verifies proof, consumes the challenge, creates a user, or creates a
session. Proof is submitted through the separate POST verification flow. After
that response, the client chooses its destination from purpose and returned
state, such as Profile, Onboarding, or a step-up continuation. Backend auth
core remains independent from whether the client is iOS, Android, or web.

Referrer protection, an analytics-free auth route, removal of the token from a
browser URL, and fallback behavior are technical requirements of Stage 3
Iteration 3 rather than additional product decisions.

The browser fallback is a minimal first-party document with no analytics,
tracking pixels, third-party fonts, scripts, images, or other subresources that
could receive the original URL. It validates the challenge ID as a canonical
UUID and the token as a canonical magic-link token, keeps the token only in
memory, and calls `history.replaceState` to remove the query string before
rendering normal UI or invoking integrations. A reload after replacement does
not recover the token. Verification still requires an explicit client action
that submits the separate POST request; loading the fallback document alone is
never authentication.

Responses for `/auth/verify` use at least `Referrer-Policy: no-referrer`,
`Cache-Control: no-store`, a restrictive Content Security Policy, and search-
engine exclusion such as `X-Robots-Tag: noindex, nofollow, noarchive`. CDN,
load-balancer, reverse-proxy, web-server, application, error-reporting, and
crash-reporting configuration must redact the `token` query value and must not
record the full sensitive URL. The route loads no generic analytics or session-
replay SDK before URL cleanup.

Application observability normally records only structured non-proof metadata,
such as `challengeId`, `deliveryId`, `templateProtocolVersion`, and normalized
provider outcome. A redaction helper is a defensive fallback at an exceptional
boundary; it is not permission to treat the full magic-link URL as a normal
logging value.

The public origin serves the iOS association file at
`/.well-known/apple-app-site-association` and the Android association file at
`/.well-known/assetlinks.json`. Their application identifiers, signing
identities, and path scope are deployment configuration; authorization should
be limited to the required authentication route rather than unrelated site
paths. Native and fallback clients validate canonical inputs before constructing
the POST request, while the backend independently repeats all validation and
never treats client validation as a security boundary.

Decision 2 is approved. The six-digit OTP appears directly in the email
subject so notification previews can support fast manual entry without opening
the message. The canonical sender and subject format are:

```text
From: Unicon <noreply@uniconnection.app>
Subject: 482731 — Your Unicon sign-in code
```

`AUTH_EMAIL_FROM` must equal the canonical From value above exactly. Startup
rejects alternate display names or addresses, and the provider adapter rejects
a submission whose immutable content does not match the validated sender.

The generated OTP replaces `482731` without spacing or reformatting. This
knowingly exposes a short-lived notification preview to anyone who can see the
device screen. The product accepts that trade-off because the OTP is a
single-use proof bound to a challenge with a fixed lifetime, database-backed
attempt limits, atomic consumption, and replay protection. The email body must
remain fully usable when notification previews are hidden.

OTP AutoFill is a separate mobile-integration enhancement, not a guaranteed
property of email delivery. The template remains OTP-friendly and native OTP
inputs use the appropriate iOS and Android autofill hints, but extraction
behavior must be tested separately with real devices and representative Apple
Mail, Gmail, and Outlook clients. Stage 3 must not claim that an operating
system will always extract the code. The magic link remains an equal
passwordless proof option that requires no manual OTP entry.

Decision 3 is approved. The `Email` frame `130:173` in the Unicon Figma file
`DzXnzo9NGRISTJtlRXb8T0` is the authoritative visual reference for the V1
template. It defines the Unicon logo treatment, hierarchy, code block, primary
magic-link action, expiry copy, and security footer. Production HTML adapts the
reference to email-client constraints, responsive layout, system font
fallbacks, dark mode, blocked images, Outlook-compatible actions, and an
equivalent plain-text version without changing its visual direction.

Decision 4 is approved as the V1 delivery retry policy defined above: five
processing attempts, 5/15/30/60-second backoff with uniform 20-percent jitter,
a 10-second HTTP timeout, a 45-second processing lease, a 120-second minimum
remaining validity window, and Resend's 24-hour idempotency window. All four
Stage 3 product and architecture decisions are closed.

## Proof security

### OTP

The OTP is generated with a cryptographically secure random source and
formatted as exactly six decimal digits. Because its search space is only one
million values, the stored value must be a keyed HMAC, not a plain digest or
password hash.

The HMAC input binds at least:

```text
challenge ID
purpose
normalized identity
OTP
```

HMAC-SHA-256 uses a deterministic length-prefixed binary encoding rather than
ambiguous string concatenation. Each field is encoded as an unsigned 32-bit
big-endian byte length followed by its bytes, in this exact order:

```text
"unicon.auth.challenge.proof.v1" (UTF-8)
proof method: OTP or MAGIC_LINK    (UTF-8)
challenge purpose                 (UTF-8 enum value)
canonical lowercase challenge ID  (UTF-8)
normalized identity               (UTF-8)
proof bytes
```

OTP proof bytes are the six ASCII digits, preserving leading zeroes. A magic
link exposes its 32 random bytes as unpadded base64url, but those original 32
bytes are used as the HMAC field after strict decoding. The database stores the
32-byte HMAC result as raw bytes, with the key version in a separate field.

HMAC protocol v1 is immutable once challenge hashes have been persisted. Its
domain, proof-method values, field order, length encoding, string encodings,
and proof representations cannot be changed in place. Any incompatible change
defines a new protocol version and retains v1 verification while v1 challenges
exist. `hashProtocolVersion` selects this encoding contract;
`hashKeyVersion` independently selects secret key material.

The database stores the HMAC and `hashKeyVersion`. HMAC and encryption keys are
independent from each other and from JWT and rate-limit secrets, and both
support controlled rotation. Comparison is constant-time. The encrypted copy
exists only to support stable delivery and is never used to decide whether a
submitted proof is valid.

Each incorrect OTP atomically increments `failedAttemptCount`. The fifth
failure locks the challenge. Concurrent incorrect attempts cannot bypass the
limit.

### Magic link

The link contains an independent 256-bit random secret. Its verification
representation is a keyed hash, while its recoverable delivery representation
exists only inside the shared encrypted proof envelope. Its canonical URL uses
the approved client-neutral `https://uniconnection.app/auth/verify` route and
is an iOS Universal Link and Android App Link with an HTTPS fallback.

Opening a `GET` link never consumes proof or creates a session. Email scanners
and preview services may follow links automatically. The app or fallback page
must exchange the secret through an explicit `POST` verification request.
Tokens must not enter analytics, referrers, application logs, or provider
error records and must be removed from the browser URL as early as possible.

## Request, resend, and verification concurrency

Only one active `SIGN_IN` challenge is authoritative for a normalized identity.
Repeated initial requests for the same identity and purpose resolve and return
the reusable live challenge without automatically creating another Delivery or
charging Delivery quota/cooldown. Explicit Resend requests the next Delivery.
Any future path that creates another Delivery must use the same authoritative
next-Delivery admission boundary.

The implementation must serialize challenge creation and delivery eligibility
for the identity and purpose. A dedicated subject row, PostgreSQL advisory
lock, or equivalent database lock may be used; an unprotected read followed by
create is insufficient.

Verification uses a conditional update or row lock. At most one concurrent OTP
or magic-link request may consume the challenge. In one transaction the
service must:

1. recheck purpose, lifetime, lock, attempt, and consumption state;
2. verify and consume the proof;
3. resolve, create, or transition the user;
4. create the session and security events.

The challenge verification primitive is transaction-composable: it accepts a
Prisma transaction client and never commits independently. It first locks the
challenge row with `SELECT ... FOR UPDATE`, then obtains exactly one
`clock_timestamp()` after the lock. This `operationNow` is used for the expiry
comparison and any `lockedAt`, `consumedAt`, or authenticated-at result. A
challenge is expired when `expiresAt <= operationNow`; ordinary PostgreSQL
transaction-start `now()` is not used after a potentially long lock wait.

A malformed OTP does not consume a challenge attempt. Only a canonical
six-digit OTP with a mismatching HMAC increments `failedAttemptCount`. Malformed
proofs remain subject to request-level abuse limits. A canonical or malformed
magic-link mismatch never changes the OTP attempt counter.

OTP failure is one conditional `UPDATE ... RETURNING`. The transition either
increments the counter or, upon reaching the maximum, increments, sets
`lockedAt`, and clears ciphertext, IV, and tag atomically. If an unlocked row is
ever observed with `failedAttemptCount >= maxAttempts`, verification fails
closed: the locked transaction sets `lockedAt`, clears the envelope, and
returns an internal locked result. This self-heal is mandatory, not optional.

Expected verification outcomes are returned as values so their mutations can
commit; throwing them inside the transaction would incorrectly roll back a
failed-attempt increment or expiry cleanup. Internal unavailability reasons
such as missing, purpose mismatch, consumed, locked, and expired are diagnostic
state only and must never be copied into a public HTTP error. A later explicit
mapper collapses them according to the approved public contract.

After accepted proof, the caller owns the remaining transaction. An explicitly
classified business outcome follows its own documented commit/rollback
contract; `SESSION_LIMIT_REACHED` is already defined to commit consumption.
Technical or internal failures throw and roll back the entire transaction,
including consumption. Commit behavior for other account/deletion outcomes is
defined only in their owning implementation stage.

No successful challenge may create two sessions because of concurrent calls.
The active-session limit is a strict hard limit. If valid proof is consumed
while the user already has ten active sessions, no new or temporary session is
created and no existing session is evicted. The new client receives only
`SESSION_LIMIT_REACHED`; it receives neither the session list nor authority to
revoke sessions. The user must use an already authorized device to revoke a
session and then begin a completely new sign-in challenge. The successful
proof remains consumed.

Recovery when all ten authorized devices are inaccessible is explicitly
deferred to V2, together with additional authenticators and recovery methods.

## Accepted next-Delivery minimum interval

Status: **ACCEPTED / FIXED**. This is a Stage 4 target contract; it is not a
claim that the current Stage 3 repository already enforces admission policy.

Cooldown protects user-driven Delivery admission and queue churn with both
challenge-scoped and normalized-identity-scoped policies:

```text
policy: AUTH_CHALLENGE_DELIVERY_COOLDOWN
canonical characteristic: challengeId
NEXT_DELIVERY_MIN_INTERVAL = 60 seconds (validated V1 configuration)

policy: AUTH_IDENTITY_DELIVERY_COOLDOWN
canonical characteristic: normalizedIdentity (institutional email)
minimum interval = 60 seconds (validated V1 configuration)
```

The interval is between authoritative admission timestamps of two successfully
committed Delivery admissions of the same AuthenticationChallenge, not between
commit timestamps. The first Delivery establishes the boundary. Admission uses
fresh database-authoritative time after necessary serialization waits/locks
inside the atomic admission transaction:

```text
count = 1
windowEndAt = admissionOperationNow + configuredMinimumIntervalSeconds
```

State takes effect only when the transaction commits. Rollback means no
Delivery admission, cooldown establishment, or partial persistence of that
transaction's quota/admission mutations. Sixty seconds is V1 policy, not a
fundamental passwordless protocol property.

Use the existing AuthenticationRateLimit table with separate challenge-scoped
and identity-scoped opaque buckets. This is an admission-anchored minimum interval, not a calendar-aligned
fixed window. Do not add a cooldown field to AuthenticationChallenge or a
separate minimum-interval framework/primitive. Bucket derivation must remain
stable for active cooldown state; key rotation must not bypass it. Cooldown
must not use Delivery.createdAt, updatedAt, attemptedAt, or sentAt as its
anchor, depend on a particular Delivery's retention, or be deleted by cleanup
while still applicable.

When fresh authoritative DB time is less than windowEndAt, deny next-Delivery
admission without creating or superseding a Delivery, revoking a worker lease,
changing proof, challenge expiration, or failedAttemptCount, or moving the
boundary. Repeated denials do not extend cooldown. Return one authoritative
retryAfterSeconds, calculated as max(1, ceil((windowEndAt - operationNow) /
1 second)); the HTTP layer does not recalculate it. Independent request-abuse
policies may account for the request without changing cooldown state. At or
after windowEndAt, the next permitted, successfully committed admission
establishes a new boundary.

Cooldown is enforced by challenge and identity, independent of HTTP endpoint.
Every domain path capable of creating a Delivery, including initial creation
and replacement after lock/expiry, must share the applicable authoritative
serialization/admission boundary. Repeated initial requests for the same
identity and purpose return
a reusable live challenge without automatic Delivery creation or Delivery
quota/cooldown charge; the client can return to the OTP screen and explicitly
Resend. Returning a challenge does not reset its expiration or cooldown.

### Identity interval across challenges — ACCEPTED / FIXED

For the same normalized institutional email, any two successfully committed
Delivery admissions must have authoritative admission timestamps at least 60
seconds apart, even when their challenges differ. Initial, Resend, and Request
new code all check this identity interval. The first admitted Delivery for an
identity establishes it; every later successful admission sets the next
boundary. Challenge creation alone does not start cooldown.

Request new code after lock or expiry checks the remaining interval since the
last Delivery admission; it does not start a fresh 60-second wait on click,
lock, expiry, or challenge replacement:

```text
00:00  initial Delivery A admitted; identity boundary = 01:00
00:05  challenge A locked after five canonical wrong OTPs
00:06  Request new code denied; retryAfterSeconds = 54
01:00  if other policies allow, atomically create challenge B + initial Delivery
       and establish identity and challenge B boundaries at 02:00
```

If 60 seconds have already elapsed since the last admission, lock/expiry adds
no independent waiting penalty. A cooldown denial must not persist a replacement
challenge as a completed new-code flow or change existing Delivery/proof state.
Creation of the replacement challenge and its initial Delivery, applicable
charges, and both cooldown boundaries must commit or roll back together.

The identity bucket is independent of challenge IDs, IP, client, and purpose:
changing these for the same email does not reset its active boundary. Check
both identity and challenge boundaries where applicable; use their later
boundary for the authoritative cooldown retry-after. Denial and rollback do
not move either boundary. Provider outcomes do not reset or refund either.
The same DB-time, opaque-key rotation, retention, and no-provider-I/O guarantees
apply to both policies. Serialize admissions across different challenges for
the same identity, not only requests sharing a challenge lock. This is a
minimum interval between admissions, not a guarantee about physical email
arrival times or provider retry spacing.

Changing email resolves a different identity/challenge context, whose initial
Delivery may be admitted immediately if that identity has no active interval
and other policies permit. Returning to a previously used email preserves its
remaining identity interval. Changing email does not reset IP/request/global
accounting. UI navigation neither cancels the previous
challenge nor controls server-side challenge lifecycle. Explicit Resend never
accepts a replacement recipient: use the authoritative identity/recipient of
the existing challenge and its stable proof. Another email requires another
identity/challenge flow.

Before Delivery charge, supersession, creation, or cooldown establishment,
check challenge lifecycle and remaining validity against Stage 3's configured
minimum validity required for submission (V1: 120 seconds). If remaining
validity is less than that minimum, deny next-Delivery admission. Closed
Delivery eligibility does not itself prohibit verification of still-live proof.
Cooldown never extends challenge lifetime.

For allowed admission, applicable atomic charges, supersession of previous
PENDING/PROCESSING Deliveries, new Delivery creation, and cooldown establishment
succeed or roll back together. Checks precede supersession. Concurrent requests
for the same challenge or normalized identity cannot both pass the same old
cooldown state and create two Deliveries. No provider I/O occurs inside the
admission transaction. After commit, the new PENDING Delivery is available to the Stage 3 worker without a
second Resend action.

Preserve Stage 3 supersession semantics: revoke further database ownership,
not physical cancellation of an already-started provider operation. Old and
new emails may both arrive with the same stable OTP and magic-link proof.
Cooldown provides no exactly-once delivery guarantee. Provider acceptance,
submission, worker claim, SENT state, HTTP arrival, permanent failure, timeout,
or ambiguous outcome neither starts, resets, nor refunds cooldown.

Passing cooldown only permits consideration of user-driven admission; it does
not authorize provider submission. New Deliveries and supersession must not
bypass applicable provider Retry-After or global/provider-pressure restrictions.
Cross-Delivery enforcement belongs to Stage 4's provider-pressure iteration;
the current per-Delivery retry schedule alone does not establish that guarantee.

Keep these mechanisms distinct:

- request abuse: request velocity and applicable request-level protection;
- Delivery window: sufficient remaining challenge validity for submission;
- Delivery cooldown: minimum interval between successful admission timestamps;
- Delivery quotas: identity/IP and other accepted Delivery budgets;
- global admission: aggregate Delivery creation protection;
- provider pressure/backoff: external submission protection;
- proof failure: canonical wrong-OTP attempt state.

## Enumeration and abuse protection

For a syntactically valid email on an active allowed domain, challenge-request
responses do not reveal whether the account is new, active, blocked, or
deletion-scheduled. `EMAIL_DOMAIN_NOT_ALLOWED` may remain explicit because it
describes domain eligibility rather than account existence.

Database-backed keyed buckets apply before account lookup to:

- challenge requests per normalized identity;
- challenge requests per IP;
- requests per app-install/device identifier as an additional spoofable
  signal;
- verification attempts per challenge, identity, and IP;
- resend attempts per challenge and identity;
- global/provider delivery pressure.

The former target of five Deliveries per identity per hour is superseded by
the accepted Delivery-budget UX capacity requirement below. The final identity
Delivery limit and window remain undecided. Other initial targets remain twenty
Deliveries per IP per hour. The former twenty-verification-attempts/IP/15-minute
target requires reassessment under the accepted failure-only, independent
identity/IP policies below; it is not a fixed all-attempts limit. Five failed
canonical OTPs per challenge remain proof-level protection.
Exact limits/windows require Stage 4 Iteration 1 review and validated runtime
configuration.

### Accepted verification mitigation boundary

Status: **ACCEPTED / FIXED** as a Stage 4 policy-design decision; enforcement is
not yet implemented.

When a verification abuse policy imposes a temporary denial, mitigation applies
only to verification operations covered by that policy. It does not itself
prohibit initial challenge requests, Resend, or Request new code, change User
status to BLOCKED, revoke sessions, or lock/consume a challenge. Request and
Delivery operations remain subject to their own independent admission policies,
including identity/challenge cooldowns, Delivery budgets, and global/provider
restrictions. Allowing a new challenge does not erase still-applicable
verification abuse state.

This boundary does not replace Stage 2 proof-level protection: the fifth
canonical wrong OTP still locks its challenge and makes both its OTP and magic
link unusable. An earlier proof failure may cause that existing transition;
a verification-policy denial does not itself increment failedAttemptCount or
perform a proof lifecycle transition.

### Accepted verification characteristics and failure-only accounting

Status: **ACCEPTED / FIXED** as policy semantics, not implemented enforcement.

Use independent normalized-identity and IP verification abuse buckets. The
identity bucket aggregates applicable failures for the same normalized email
across IPs and challenges. The IP bucket aggregates applicable failures across
identities from that source. Both policies must allow verification; a composite
(identity, IP) bucket does not replace either independent protection. Resolve
identity from authoritative challenge state, not an untrusted identity field in
the verification request. Missing challenges do not provide an authoritative
identity for failure accounting; their requests remain subject to request
protection.

Provide a larger IP failure budget than the identity budget to accommodate
shared college/public-network IPs. The accepted short-term settings are below;
long-term identity and IP values are fixed below. Compare effective allowances
over
selected windows rather than raw counts alone. Larger IP capacity reduces, but does not eliminate, shared-network
interference. Identity exhaustion can also deny verification to the legitimate
mailbox owner; choose mitigation duration with that risk in mind. Neither
identity limits nor IP limits automatically increase with total application
user count; tune from per-bucket legitimate traffic and abuse evidence.

These verification policies count only unsuccessful checks. Successful proof
verification does not consume either failure budget. This does not exempt
successful requests from separately selected request/resource protection.
#### Accepted verification failure definition

**ACCEPTED / FIXED:** a verification failure is a canonical proof checked against
an eligible challenge with the correct purpose and binding, resulting in a proof
mismatch. Use the domain verification outcome, not HTTP error status, to classify
it.

| Outcome | Identity/IP verification failure budgets | Challenge OTP failure counter |
| --- | --- | --- |
| Canonical wrong OTP for an eligible, correctly bound challenge | Charge both | Increment; fifth failure locks challenge |
| Canonical wrong magic-link token for an eligible, correctly bound challenge | Charge both | Unchanged |
| Successful proof | No charge | No failure increment |
| Malformed proof | No charge | Unchanged |
| Missing challenge | No charge; identity cannot be derived | Unchanged |
| Already locked, expired, or consumed challenge | No charge | No new failure increment |
| Wrong purpose or invalid binding | No charge | Unchanged |
| Infrastructure/configuration/internal error | No proof-failure charge | No fabricated proof failure |
| Verification-policy denial before proof checking | No new proof mismatch | Unchanged |

The fifth canonical wrong OTP is a chargeable mismatch: the challenge was
eligible before that failure caused the lock. Requests to the already locked
challenge are not further mismatches. A correct proof arriving after expiry or
consumption likewise does not become a wrong proof. Preserve Stage 2 lifecycle
handling, including its existing expiry cleanup and attempt-limit self-heal;
this classification does not prohibit those transitions or change them.

Excluded outcomes are not exempt from request protection. Provide independent
request-level controls for malformed input, missing/terminal challenges,
purpose/binding rejection, and other traffic, including requests rejected before
proof verification. Successful requests may also be accounted for there. Do not
accept a client-supplied email to charge an unknown challenge's identity bucket.
No specific request thresholds or HTTP outcome mapping are chosen here.

#### Accepted V1 short-term verification — GCRA

Status: **ACCEPTED / FIXED** as configurable V1 policy semantics; enforcement is
not implemented yet. GCRA replaces the previously selected short-term fixed
window, additional 60-second denial, and full-reset recovery. A sliding-window
log is not required. Separate long-term identity and IP policies are fixed below.

| Scope | Full burst capacity (unit failures) | Sustained replenishment rate |
| --- | --- | --- |
| Normalized identity | 6 | 6 failures per 60 seconds (one allowance per 10 seconds) |
| IP | 72 | 72 failures per 60 seconds (one allowance per 5/6 second) |

Burst capacity means exactly six or seventy-two immediately chargeable unit
failures from idle state, not a library-specific max_burst argument that might
include an extra allowance. These are burst-plus-rate policies, not strict
maxima of six/seventy-two failures in every rolling 60-second interval.
Capacity recovers continuously; there is no separate denial-duration penalty,
periodic full reset, or background refill job.

Each bucket stores a theoretical arrival time (TAT), representing rate debt,
not the total failure history. Conceptually, for unit charge, interval I equal
to period/rate, burst capacity B, and fresh authoritative DB time t:

```text
missing/fully idle state: TAT = t
eligible:                t >= TAT - (B - 1) * I
on committed mismatch:   TAT = max(TAT, t) + I
on success or denial:    TAT unchanged
```

These equations specify the intended burst convention, not a required SQL
representation. Both independent buckets must permit verification. A canonical
proof mismatch charges both atomically under the agreed verification
transaction semantics; a successful proof, excluded outcome, or denied request
must not advance either TAT. Never charge before proof checking and silently
retain that charge for success. How to compose admission, proof checking, and
committed charges safely under concurrency is still an Iteration 1 decision.

If insufficient capacity exists, deny covered verification until eligibility
returns. Compute one authoritative retry-after from the latest eligibility
time among applicable denying buckets; HTTP delta-seconds round the positive
wait upward. No extra 60 seconds is added and repeated denials do not extend
the wait. At exact eligibility, verification may proceed if other policies
allow. Internal arithmetic must preserve subsecond precision for the IP rate;
round only the public wait, not every replenishment interval.

For example, six nearly simultaneous identity failures consume its idle burst;
one allowance returns approximately ten seconds later, rather than after an
extra minute. In a pure GCRA failure stream, six at time zero and one at each
of 10, 20, 30, 40, and 50 seconds permit eleven failures before one minute.
Stage 2 challenge lock and Delivery policies still independently constrain real
flows; this example explains the GCRA envelope, not a bypass of those policies.

Accepted OTP and magic-link mismatches share each scope's budget across
challenges. Successful proof consumes neither. Five canonical wrong OTPs still
lock their challenge; rate recovery does not unlock/extend it. A replacement
challenge does not reset identity/IP TAT, and short-term recovery never clears
independent long-term state. IP capacity is a V1 shared-network assumption, not
a concurrent-user cap or a guarantee that no legitimate campus traffic is denied.

Use PostgreSQL as planned with atomic time-based enforcement across replicas;
GCRA does not require Redis. Existing count/windowEndAt cooldown persistence
remains unchanged in meaning. TAT storage, safe expiry/cleanup, and configuration
rollout need an explicit persistence design in Iterations 2–3: do not pretend
that the existing fixed-window counter implementation already supplies GCRA.
Cleanup must not erase outstanding rate debt before full burst is restored.
Retained security events/analytics are separate from compact GCRA state.

Keep Stage 2 proof semantics and Delivery budgets independent. Endpoint
coverage, concurrent admission/charge and commit behavior,
and remaining recovery details not fixed below stay open in Iteration 1.

#### Accepted V1 long-term identity verification — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 policy values for later
tuning from operational analytics; enforcement is not implemented yet.

| Scope | Full burst capacity | Sustained replenishment rate |
| --- | --- | --- |
| Normalized identity | 8 chargeable failures | 12 per 3600 seconds (one allowance per 300 seconds) |

The policy aggregates the same accepted OTP/magic-link mismatch categories for
one normalized institutional email across all IPs and challenges. Keep its TAT
separate from short-term identity and IP TAT. All applicable policies must allow
verification; compute authoritative retry-after from the latest blocking
eligibility time. Success, excluded outcomes, and denied requests do not advance
TAT. There is no additional timed denial or periodic full reset. Creating or
replacing a challenge and short-term recovery do not erase long-term debt.
Use the same exact burst convention, authoritative-time arithmetic, atomicity,
privacy, configuration/rollout, safe-cleanup, and telemetry requirements as the
short-term GCRA policies.

This accepted burst of eight supersedes the earlier burst-twelve candidate;
the sustained rate remains 12/hour. It is not a strict failures-per-hour quota.
Long-term burst does not override short-term eligibility.

For risk comparison only, with idle buckets, no other blockers, and a hypothetical
challenge without the existing five-OTP lock, combined identity policies permit
at most nine chargeable failures over [0, 600) seconds: six at the start, one at
10 seconds, one at 20 seconds, and one at 300 seconds. The next long-term
allowance is at 600 seconds when that challenge is already expired. For a
uniform six-digit OTP and nine distinct guesses against that one proof, random
success probability is 9/1,000,000 = 0.0009% (approximately 1 in 111,111).
This assumes atomic enforcement with no parallel overshoot or rate-debt reset;
it is not a system-wide compromise probability or a bound for repeated attacks
across identities/challenges. The former burst-twelve scenario admitted thirteen
guesses (0.0013%); the existing per-challenge lock limits guesses to five
(0.0005%). The burst-eight alternative therefore retains more per-proof guessing
risk than the current lock, rather than demonstrating that the lock has no value.

This is not current runtime behavior: Stage 2 still locks a challenge after five
canonical wrong OTPs. Removing that lock is a separate review/decision after the
full verification policy is defined and enforcement is implemented and verified.
This change does not modify challenge lifecycle, OTP counters, six-digit format,
600-second lifetime, or Delivery limits.

#### Accepted V1 long-term IP verification — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 policy values, subject to
later tuning from aggregate operational data; enforcement is not implemented.

| Scope | Full burst capacity | Sustained replenishment rate |
| --- | --- | --- |
| IP | 360 chargeable failures | 360 per 3600 seconds (one allowance per 10 seconds) |

Aggregate accepted OTP/magic-link mismatches across identities/challenges from
the same canonical source IP. This limits sustained verification abuse spread
across many identities below the short-term IP rate. Retain short-term IP burst
72/rate 72 per minute: long-term burst 360 does not authorize 360 immediate
failures. These are burst-plus-rate parameters, not a strict 360-failures/hour
quota or a number of guaranteed concurrent users.

Maintain an independent TAT for each of the four verification buckets:
short-term identity, long-term identity, short-term IP, and long-term IP. All
must allow the covered operation. Chargeable mismatches update applicable
buckets consistently and atomically; success, excluded outcomes, and denied
requests do not advance TAT. Compute one retry-after from the latest blocking
eligibility time. No additional timed penalty or periodic full reset applies.
Challenge replacement, identity changes within an IP, and short-term recovery
do not erase long-term IP debt. Denial affects verification only, not request/
resend by itself. Existing Stage 2 OTP lock remains unchanged pending review.

Apply shared GCRA authoritative-time, concurrency, opaque-key, privacy,
configuration/rollout, safe-cleanup, and telemetry requirements. Size and tune
from legitimate shared-network failures as well as abuse: a busy or attacking
client on a shared IP can consume capacity needed by others. Successful checks
consume no failure capacity, but are still covered by independent request
protection. No new request/Delivery/global/provider parameters are selected here.

### Policy configuration and operational analytics requirements

Status: **ACCEPTED** implementation requirements for Stage 4. Operators must be
able to tune policy thresholds, counting windows, GCRA rates/burst capacities,
and denial durations where applicable through
clearly named, documented, validated configuration without editing algorithms
or business services. Use ConfigService, positive integer limits and *_SECONDS
durations, and public examples in .env.example when implementing configuration.
Keep policy values in a focused configuration boundary. This does not mandate
an admin UI, runtime editing, or a new configuration service. Specify how values
become effective across replicas and what happens to active windows, rate debt,
and denials
before implementation; a rollout must not accidentally reset protection.

Provide backend operational metrics to identify which policies affect users:

- checks/allow/denial counts by policy, scope, operation, and short/long tier;
- committed chargeable proof failures and successful verification outcomes;
- distributions of authoritative retry-after/wait durations;
- limiter latency, infrastructure failures, and transaction retry/conflict counts;
- effective policy/configuration version so before/after tuning is interpretable.

Distinguish capacity-exhausting failure charges from requests denied for
insufficient capacity and from explicit timed mitigation where applicable. Attribute overlapping policy denials consistently rather than
presenting all as one generic rate-limit metric. If independent rules are
short-circuited, do not report unchecked rules as having allowed the request.
Select the telemetry backend and precise collection/export mechanism later;
include a documented way to query/visualize these aggregates for tuning.

Use bounded-cardinality labels; do not put emails, IPs, user/challenge IDs,
opaque bucket keys, or other per-subject identifiers in metric labels. Never
record OTPs, link/other tokens, proof hashes/envelopes, sensitive URLs, secrets,
or raw provider errors. This is aggregate backend operational telemetry, not
client tracking on the analytics-free magic-link fallback. Aggregate denial
rates alone cannot distinguish abuse from false positives or prove how many
legitimate people were blocked; review them with success rates, workload
patterns, and support evidence before changing thresholds. Telemetry failure
must not alter authoritative admission/accounting decisions.

### Accepted Delivery-budget UX capacity requirement

Status: **ACCEPTED** as a policy-design requirement, not an implemented limit.
Starting with unused Delivery budgets and no unrelated traffic, their selection
must accommodate one challenge's initial Delivery, a Resend at every permitted
60-second interval through the last eligible instant, and one initial Delivery
for a replacement challenge after lock or expiry, once any remaining identity
interval has elapsed. Under the V1 600-second TTL
and 120-second minimum remaining validity, the reference scenario is:

```text
00:00                 initial Delivery for challenge A           1
01:00 through 08:00    eight successfully admitted Resends      +8
10:00 or later        Request new code: initial for challenge B +1
Total                                                         10
```

This establishes a reference capacity of ten admitted Deliveries, not a chosen
limit of ten per hour or a guarantee that a second full Resend cycle is covered.
Final limits, window durations/anchoring, and the resulting email-bombing exposure
remain decisions for Stage 4 Iteration 1. Review email and IP budgets together
against the scenario; account separately for legitimate shared-IP usage.

All Delivery admissions remain subject to challenge lifecycle, cooldown,
Delivery budgets, global admission, and provider restrictions. Verification-only
mitigation does not itself deny Delivery admission.
The requirement does not reserve quota for a client, bypass exhausted/shared
budgets, reset identity/IP accounting on a new challenge, or guarantee physical
email delivery. Resends keep the same proof and do not reset OTP attempts;
replacement challenges receive new proof and must not bypass cross-challenge
verification protection.

Device metadata is informational and spoofable. It contributes to throttling
and risk context but is never identity proof.

## Email and mobile behavior

Each v1 email is sent as `Unicon <noreply@uniconnection.app>`, places the
six-digit code at the beginning of the subject in the approved
`482731 — Your Unicon sign-in code` format, and repeats it prominently near the
beginning of the body before the magic-link action. The wording and layout are
OTP-friendly for iOS and Android input, notification, copy, and paste behavior,
but email delivery does not guarantee operating-system AutoFill. The app must
not ask for mailbox or notification access merely to read OTPs. Magic-link use
requires no manual code entry.

The mobile client stores the opaque challenge ID and submits it with the code.
The challenge ID is a selector, not a secret. The code alone or the challenge
ID alone is insufficient.

The fallback web page does not establish a browser session. It exchanges the
link through the API or directs the user back to the native app, and removes
the token from the visible URL as early as possible.

## Authentication and session boundary

Every authenticator converges on a credential-neutral result:

```text
AuthenticatedPrincipal
├── userId
├── authenticationMethod
├── authenticatedAt
└── sourceProofId?
```

`SessionCreationService` remains independent from how identity was proven.
Sessions record `authenticationMethod` and `authenticatedAt`. V1 methods are
`EMAIL_OTP` and `EMAIL_MAGIC_LINK`.

Existing session invariants remain unchanged:

- access and refresh JWTs contain `sub` and `sessionId`;
- access authorization checks both JWT and active session/account state;
- refresh tokens are stored only as cryptographic hashes;
- refresh rotation is atomic and single-use;
- inactivity expiration slides only on refresh;
- the active-session limit is enforced transactionally;
- multiple devices have independent sessions;
- logout and revocation take effect immediately;
- session metadata and GeoIP remain optional, approximate, and spoofable.

## Recent authentication and account deletion

Sensitive actions use recent authentication rather than a password. The
approved recent-authentication window is 600 seconds and is evaluated from the
server-side session authentication record.

Requesting account deletion requires an active session with recent proof. An
older session receives `RECENT_AUTHENTICATION_REQUIRED` and completes a
`STEP_UP` challenge bound to that user and session before retrying. Successful
step-up updates the server-side session `authenticatedAt` and
`authenticationMethod`; it does not create another session.

Deletion immediately changes the account to `DELETION_SCHEDULED`, revokes all
sessions, and invalidates active authentication challenges and continuation
grants. Normal sign-in during the grace period does not cancel deletion.

For a deletion-scheduled account, successful `SIGN_IN` proof issues an
`ACCOUNT_DELETION_CANCEL` continuation instead of a session. The client then
explicitly confirms cancellation with that short-lived, single-use
continuation. The transaction restores `ACTIVE`, creates one new session, and
leaves every old session and token revoked.

Terminal deletion anonymizes the user tombstone, removes sessions, challenges,
deliveries subject to retention rules, authentication credentials, and direct
identifiers. The original email may then create a new, unrelated account.

## Security events and notifications

The target challenge event catalog includes:

```text
AUTH_CHALLENGE_REQUESTED
AUTH_CHALLENGE_DELIVERY_FAILED
AUTH_CHALLENGE_VERIFIED
AUTH_CHALLENGE_FAILED
AUTH_CHALLENGE_LOCKED
AUTH_CHALLENGE_REPLAYED
STEP_UP_SUCCEEDED
STEP_UP_FAILED
SESSION_CREATED
SESSION_CREATION_FAILED
SESSION_REVOKED
OTHER_SESSIONS_REVOKED
SUSPICIOUS_ACTIVITY_DETECTED
ACCOUNT_DELETION_REQUESTED
ACCOUNT_DELETION_CANCELLED
ACCOUNT_DELETED
```

Events never contain raw or hashed proof material. Unknown identities may
produce events without a user relation. Delivery records and security events
use existing configurable retention boundaries.

Every committed `SESSION_CREATED` flow continues to dispatch one best-effort
new-session notification after commit. Notification failure never rolls back
authentication. Challenge email delivery is different: it is required for the
email proof flow and has an explicit delivery result.

Risk analysis should evolve from password-specific failed-login terminology to
failed authentication proof and session signals. Risk initially records events
and notifications; it does not automatically block users.

## Personal recovery email

V1 has no self-service recovery after loss of the institutional mailbox. A
future authenticated user may add and independently verify a personal email.
That address can later support recovery, but email equality never links or
merges accounts. Adding, replacing, or removing a recovery method requires an
active account, recent authentication, independent verification, notification
of affected addresses, and preservation of at least one usable recovery or
authentication path.

Mailbox reassignment is a mandatory threat case. Control of a formerly used
institutional address must not restore a historical account after that address
has been detached or replaced.

## V2 extensibility

V2 may add password, passkey, and in-app proof delivery. They extend the same
orchestration and session boundary rather than restoring a legacy login flow:

```text
email OTP or link ─┐
optional password ├→ AuthenticatedPrincipal → SessionCreationService
passkey ──────────┘
```

Password is an optional specialized `PasswordCredential`, never a required
`User.passwordHash`. Passkeys use their own WebAuthn credential and challenge
models. They need not share the email challenge table; they must produce the
same authenticated principal and obey the same account and session policies.

Future `IN_APP` delivery may send the same stable OTP to a session already
authorized for the same `User.id`. A client-supplied email or device identifier
alone never authorizes in-app delivery.

## Implementation transition

No production users or released mobile clients depend on the password API, so
the target implementation removes rather than deprecates:

```text
POST  /auth/register
POST  /auth/login
POST  /auth/verify-email
POST  /auth/resend-verification
POST  /auth/forgot-password
POST  /auth/reset-password
PATCH /account/password
```

Historical migrations remain immutable. A new migration removes password and
legacy verification/recovery storage and adds challenge, delivery, rate-limit,
and session-authentication fields. Runtime code and documentation must move in
small, tested stages described in `auth-roadmap.md`.
