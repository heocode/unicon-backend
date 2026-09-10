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
resend cooldown:              60 seconds
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
Failed delivery attempts count toward abuse limits. The user-visible resend
cooldown starts after the provider accepts a delivery, while repeated
synchronous failures remain bounded by request rate limits.

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

`attemptedAt` records the first provider submission and is not moved by
retries. Ambiguous retries are allowed only while reuse of the same
idempotency key remains inside the provider's documented idempotency window.
If that window would be exceeded, delivery becomes terminal rather than risk a
duplicate send. Maximum attempts, backoff, challenge expiry, and the provider
window all independently bound retries.

One Delivery also fixes an immutable `templateProtocolVersion`. Immutable
email content consists only of recipient, From, subject, HTML, and plain text.
Operational submission context separately carries `deliveryId`,
`idempotencyKey`, and `templateProtocolVersion`; these fields are not email
body or provider payload fields. No generic provider request-options bag is
part of the V1 contract. Every retry reproduces byte-equivalent email content
and the same idempotency key. Rendering uses the persisted template protocol rather than the current
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
idempotency key, byte-equivalent payload, active challenge, and provider
idempotency window. `attemptedAt` fixes the first provider-submission time used
for the 24-hour window. A permanent recipient rejection, invalid provider
request, provider configuration error, or API authentication error fails
without retry and produces an internal operational alert where appropriate.

An expired processing lease with `attemptCount < 5` may be reclaimed with a
new lease and incremented count. At `attemptCount >= 5`, it is atomically made
terminal and its lease is cleared instead of granting a sixth claim. If proof
is already unavailable it becomes `CANCELLED`; otherwise it becomes `FAILED`
with the allowlisted `PROCESSING_ATTEMPTS_EXHAUSTED` reason.

Workers claim due or expired-lease deliveries in short PostgreSQL transactions
using `FOR UPDATE SKIP LOCKED`. Processing is bounded per run, non-overlapping
inside one process, safe across replicas, and allowed to finish during graceful
shutdown. Delivery retention uses bounded cleanup independent from provider
processing.

Delivery failure never consumes, unlocks, resets, or extends the challenge.

### Manual resend and supersession

A manual resend never creates or rotates an `AuthenticationChallenge`. It
preserves the same OTP, magic-link token, `expiresAt`, failed-attempt count,
consumption, and lock state, while creating a new `RESEND` Delivery with a new
delivery ID and idempotency key. Only a new sign-in request after the prior
flow finishes or expires may create a new challenge under Stage 5 rules.

Creating a `RESEND` Delivery atomically cancels previous non-terminal
Deliveries for that challenge with `SUPERSEDED_BY_RESEND` and clears their
leases. An old worker therefore loses ownership and cannot later finalize its
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
Repeated initial requests should reuse the existing challenge and create a new
delivery when cooldown and rate limits allow, rather than rotate proof.

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

Initial policy targets are five email deliveries per identity per hour, twenty
per IP per hour, five failed OTP attempts per challenge, and twenty
verification attempts per IP per fifteen minutes. Exact values are validated
configuration and may be tuned from production evidence.

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
