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
├── status
├── recipientSnapshot
├── idempotencyKey
├── providerMessageId?
├── failureCode?
├── attemptedAt?
├── sentAt?
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

Each delivery has a unique idempotency key. Retrying one provider call reuses
that delivery; a user-requested resend creates a different delivery. Failed
delivery attempts count toward abuse limits. The user-visible resend cooldown
starts after the provider accepts a delivery, while repeated synchronous
failures remain bounded by request rate limits.

Delivery failure never consumes, unlocks, resets, or extends the challenge.

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
exists only inside the shared encrypted proof envelope. The URL is an iOS
Universal Link and Android App Link with an HTTPS fallback.

Opening a `GET` link never consumes proof or creates a session. Email scanners
and preview services may follow links automatically. The app or fallback page
must exchange the secret through an explicit `POST` verification request.
Tokens must not enter analytics, referrers, application logs, or provider
error records.

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

Each v1 email contains the six-digit code prominently, preferably in the
subject and at the beginning of the body, followed by the magic-link action.
The code wording and layout must support iOS one-time-code AutoFill and normal
Android keyboard, notification, copy, and paste behavior. The app must not ask
for mailbox or notification access merely to read OTPs.

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
