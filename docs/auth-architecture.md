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
OTP failure protection:       identity/IP short- and long-term GCRA
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
```

Stage 4 Iteration 5 block 2 removes the automatic attempt-count lock.
`failedAttemptCount` records canonical OTP/link mismatches diagnostically; it
never controls eligibility. `maxAttempts` and AUTH_CHALLENGE_MAX_ATTEMPTS are
removed. The transition migration preserves existing terminal rows and marks
legacy unconsumed/unlocked rows at the former threshold as locked, clearing
only their proof envelope. Healthy rows, proof hashes, expiration and GCRA debt
are preserved. Existing terminal locked rows never reopen automatically.

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
its Delivery rows. Cleanup cycles envelope clearing, retention deletion and
identified-orphan subject deletion under one configurable per-run batch budget.
The phase cursor persists across runs, including a one-batch budget, so no phase
starves. Empty database checks consume that budget, overlapping runs in one
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

Claiming a Delivery atomically creates a unique UUID `processingLeaseId` and
sets `processingLeaseExpiresAt`. Stage 4 Iteration 6 block 4 separates this
uncharged lease from a started processing attempt. After shared mail permission,
the current owner revalidates challenge/lease and atomically increments
`attemptCount`, sets `processingAttemptStarted`, and records `attemptedAt`.
Internal processing failures also start/charge an attempt before classification.
The counter remains a fail-safe processing budget, not an exact provider request
count: a crash after charging but before HTTP still spends the attempt. Local
capacity waiting and crashes before attempt start do not spend it. Every
worker-owned sent, retry, failed, or cancelled transition from processing must
match both
`status = PROCESSING` and the supplied lease ID. Historical resend supersession
could revoke lease ownership without pretending to own it; the current manual
resend path preserves unfinished work and its lease. A stale worker cannot
overwrite a later lease-owned state. Lease fields are present only while
processing and are cleared by a successful state transition.

The provider call is never made inside a database transaction. Before each
submission the current lease owner checks that the challenge exists, remains
unconsumed and not otherwise terminal, has not expired, and
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

`attemptedAt` records the latest started processing attempt. A new lease leaves
it unchanged; local capacity deferral preserves both it and `attemptCount`.
`processingAttemptStarted` distinguishes a charged attempt under the current
lease from unstarted preparation and is cleared on release/terminal transitions. In
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

Because `attemptCount` is incremented at processing start, retry selection uses
this exact mapping rather than direct array indexing:

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
new unstarted lease. Starting its processing after permission increments the
count; a prior charged attempt is never refunded. At `attemptCount >= 5`, it is atomically made
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
four lanes per replica, and at most twenty claims per cycle. Block 4 adds an
advisory subsecond wake for timed shared-capacity deferral without overlapping
cycles; the database gate remains authoritative. A deferral stops new claims
across the current cycle after already-running lanes finish. Effective provider
concurrency is therefore replica count multiplied by four; deployment must
respect provider throughput because V1 has no distributed global semaphore.
Processing is non-overlapping inside one process and allowed to finish during
graceful shutdown. An exception escaping classified orchestration is unexpected:
the worker records only safe telemetry and leaves the row to lease-expiry
recovery. Delivery retention uses bounded cleanup independent from provider
processing.

Delivery failure never consumes, unlocks, resets, or extends the challenge.

### Manual resend: accepted V1 target and Stage 3 transition

A manual resend never creates or rotates a challenge, changes its recipient,
proof, expiration, or proof-attempt state. For an otherwise eligible challenge,
if a PENDING or PROCESSING Delivery already exists, resolve that unfinished
Delivery as awaiting/in-progress work. Do not create another Delivery, supersede
work, revoke a lease, alter retry scheduling, charge Delivery budgets, or move
cooldown. Request-level accounting still applies.

Only when no unfinished Delivery exists may a resend admit a new RESEND Delivery
with a new ID and provider idempotency key, subject to lifecycle, delivery
window, cooldown, Delivery quotas, global rate, and backlog capacity. A prior
SENT/FAILED/CANCELLED state alone does not establish admission eligibility.
There must be at most one PENDING or PROCESSING Delivery per challenge across
all entry points, including concurrent initial/resend requests. Enforce existence
checks and creation under the same authoritative serialization boundary.

This ACCEPTED / FIXED V1 target replaces automatic resend supersession. Stage 4
Iteration 4 block 1 implements unfinished-work resolution in persistence; block 2
composes existing-challenge resend with the Delivery window and four auth rate
policies. Block 3 adds SIGN_IN initial/replacement composition below;
global/backlog enforcement retains its later owner. The historical
SUPERSEDED_BY_RESEND cancellation reason remains readable, but manual resend no
longer emits it or revokes leases. Historical supersession cannot guarantee
physical cancellation of provider I/O; stable proof and provider idempotency
remain necessary and exactly-once email delivery is not promised.

#### Iteration 4 block 1 — transaction-composable resend persistence

`AuthenticationDeliveryRepository.createResendDeliveryInTransaction` uses a
caller-owned interactive transaction. The existing `createResendDelivery`
method delegates within its own transaction; neither path is connected to a
public endpoint. Both are persistence operations, not complete abuse-protected
Delivery admission. The new method does not open a nested transaction, commit,
retry or invoke a provider. Its result is provisional until the outer commit.
Finite timeouts, confirmed-abort retries and uncertain-commit reconciliation
remain the owner's responsibility.

Creation accepts READ COMMITTED or SERIALIZABLE isolation; root clients,
unsupported isolation and nontransactional scope fail before insertion. A
reserved, immediately released `unicon_delivery_creation` savepoint verifies
real transaction scope. Both initial and resend creation lock the challenge
row first. They then select unfinished Delivery rows in ID order with
FOR UPDATE; more than one existing unfinished row is a technical invariant
failure, without cancellation, repair or insertion. No migration removes or
rewrites historical data. This is a shared writer protocol, not a new unique
database constraint; every application creation path must use it.

Resend obtains fresh DB time after both kinds of row-lock wait and retains the
challenge lifecycle and complete-envelope eligibility checks. An unavailable
challenge returns CHALLENGE_UNAVAILABLE even if unfinished work exists. Otherwise an
existing PENDING/PROCESSING Delivery returns EXISTING with its original ID,
origin and provider idempotency key. No field changes: this includes updatedAt,
retry schedule, attempt count and even an expired processing lease, whose
recovery still belongs to the worker. With no unfinished work, the operation
creates one RESEND Delivery using the challenge's authoritative recipient and
returns CREATED. Challenge, proof and all rate-limit tables are unchanged.

`createInitialDelivery` remains a strict insert operation inside the caller's
transaction; it rejects existing unfinished work rather than creating a second
row or resolving a reusable challenge. Repeat-initial challenge resolution
belongs to the domain coordinator. Sharing the challenge lock prevents mixed
initial/resend races from inserting two unfinished Deliveries. These row locks
are transaction serialization, not a change to challenge.lockedAt or proof
failure semantics. Iteration 5 block 2 removes attempt-count eligibility.

PostgreSQL tests use two independent Prisma clients to cover mixed creation
and concurrent resend, unchanged pending retry/processing lease state, outer
rollback, historical duplicate rejection, unavailable challenges and expiry
during challenge/Delivery row waits. The real orchestration/decrypt/render
integration replaces only the email provider: an in-flight resend now preserves
ownership and produces no second submission; a new resend after terminal SENT
uses the same proof with a new Delivery/provider idempotency key.

The persistence methods alone do not enforce the 120-second new-Delivery window
or charge budgets; they must not be exposed as a complete admission API. Block 2
composes those checks below. Replacement and durable operation reconciliation
remain later blocks.

#### Iteration 4 block 2 — existing-challenge RESEND admission

`AuthenticationDeliveryAdmissionService.admitResendInTransaction` is an internal
caller-owned operation for an existing challenge. Input carries its ID, source
IP and internal Delivery creation metadata, never an email/recipient override.
The service captures input before waits, validates the canonical challenge UUID
and strict source IP, and uses the authoritative identity from the locked
challenge. READ COMMITTED and SERIALIZABLE are supported. Root clients,
unsupported isolation and a second admission on the same transaction fail
closed. Do not compose this with earlier limiter calls or run concurrent
commands on the transaction client; the complete entity/bucket lock order
must be respected by every caller.

`getResendContextInTransaction` separates locked context resolution from the
strict persistence insertion path. Lock order is challenge, unfinished Delivery
rows in ID order, the complete four-policy advisory-lock union, GCRA rows, then
cooldown rows. Unavailable challenges return CHALLENGE_UNAVAILABLE. Existing
unfinished work returns EXISTING before touching rate policies; a closed
new-Delivery window or active cooldown does not cancel or replace that work.
Historical lockedAt remains terminal; diagnostic failure counts do not affect
admission.

For genuinely new work the auth-specific limiter accepts a captured Delivery
window (exact expiresAt microseconds and the existing configured minimum
validity). It samples fresh DB time after all bucket/row-lock waits, checks
expiry first, then requires remaining validity >= the configured minimum
(V1: 120 seconds), before evaluating/charging any policy. Expiry returns
CHALLENGE_UNAVAILABLE; a still-live challenge below the minimum returns
DELIVERY_WINDOW_CLOSED. This is an explicit auth window check, not a generic
callback or policy framework. The original two-argument limiter API remains
unchanged for its existing internal consumers.

All four policies evaluate at that same operationNowMicros. RATE_LIMITED carries
the authoritative rounded-up maximum wait and sorted internal policy IDs;
denial writes nothing. On allowance the service creates one RESEND Delivery
through the strict persistence path while retaining the locks already held,
then returns CREATED with the Delivery reference and admission timestamp. The
recipient is always resolved from the challenge. Proof, expiry, attempt count
and challenge lock/consumption state are unchanged. Provider transitions do
not move or refund cooldown/GCRA.

A reserved `unicon_delivery_admission` savepoint encloses context resolution,
all limiter writes and insertion. It is distinct from the inner limiter and
persistence scope-check savepoints. Insertion/other technical failure rolls
back all admission writes even if the owner catches it and commits earlier
unrelated work. Errors reuse safe infrastructure reasons; raw database errors,
queries, recipients, keys and causes are not exposed. Confirmed aborts propagate
as TRANSACTION_ABORTED for a whole-owner retry after outer rollback. The service
does not open/commit/retry a transaction. Every result is provisional until
outer commit; owners provide finite timeout/connection-wait/lock bounds and
handle uncertain commit outcomes without blind replay or refunds.

Unit tests cover outcome coordination, safe errors and exact window boundaries
including one microsecond before/after 120 seconds. Real PostgreSQL integration
uses real repositories, cryptography and limiter state with independent clients:
joint creation/charges, existing-work immutability, cooldown and each GCRA
denial, unavailable/closed-window outcomes, same- and cross-challenge races,
post-bucket-wait expiry/window closure, outer rollback, actual insert-constraint
failure caught by the owner, injected 40001 insertion abort and whole-owner
retry, and unchanged rate state after worker sent/failed/retry transitions.

This block is not wired to HTTP. Block 3 adds initial/replacement admission;
global/backlog enforcement, provider I/O and an operation receipt remain outside
this coordinator.
Durable reconciliation of an unknown commit remains mandatory before exposing
the owning domain flow. Returning existing unfinished work or relying on
provider idempotency alone is not that reconciliation.

#### Iteration 4 block 3 — SIGN_IN initial and replacement admission

`AuthenticationChallengeRequestService.requestSignInInTransaction` resolves an
internal initial request after the caller has validated institutional-email
syntax and allowed-domain eligibility. It requires an already normalized
identity and strict source IP, supports READ COMMITTED/SERIALIZABLE interactive
transactions and permits one request operation per transaction. It does not
query/create a User or Session, expose proof or connect a public endpoint.
STEP_UP is not implemented by this SIGN_IN-specific entry point.

The additive migration identifies new `AuthenticationChallengeSubject` rows
with nullable normalizedIdentity/purpose fields and a unique pair, plus a
both-present-or-both-null check. Their key is a random UUID, independent of
rate-limit HMAC key rotation. Legacy rows keep their existing keys, null new
fields, timestamps and relations; no backfill, rebinding or deletion occurs.
An identity/purpose challenge index supports discovery across legacy subjects.
These identity fields are domain coordination data, not opaque rate buckets;
they must not appear in telemetry labels or logs. Block 5 below completes
identified-subject retention/finalization integration; the block 3 migration
itself does not sweep or rewrite existing domain records.

`AuthenticationChallengeRequestRepository` inserts the coordination subject
with ON CONFLICT DO NOTHING and locks the resolved row. It then locks all
unconsumed/unlocked SIGN_IN candidates for the normalized identity in ID order,
including challenges linked to legacy subjects. Fresh DB time is sampled only
after subject/challenge waits. More than one live candidate is INVALID_STATE,
without choosing a winner or repairing historical data. One usable live
candidate returns REUSED with only ID/expiration: proof, failed attempts,
expiration, deliveries and all rate/audit state remain unchanged. This includes
a live challenge below the new-Delivery validity window. A legacy reuse may
establish its canonical coordination row without rewriting the legacy subject.
A live candidate with no envelope returns CHALLENGE_UNAVAILABLE rather than generating replacement proof.

When no live candidate exists, the service generates a new UUID and uses the
existing proof factory's persistence-only hashes/encrypted envelope. It does
not persist/return the factory's transient deliveryProof. CreatedAt and fixed
expiration/retention deadlines use the fresh DB timestamp and validated
challenge settings; the INITIAL Delivery inherits that retention deadline.
Expired or terminal predecessors are never reopened, extended, rebound or
modified. A new sign-in after consumption creates a distinct challenge.
Iteration 5 block 2 removes the old OTP-attempt threshold from reuse eligibility.

`AuthenticationDeliveryAdmissionService.admitInitialInTransaction` shares the
existing-challenge admission transaction handling, window and four-policy
checks with RESEND, then calls strict initial persistence. A newly created
challenge unexpectedly resolving unfinished work is an invariant failure,
not another INITIAL charge. Subject -> candidate/new challenge -> Delivery ->
complete bucket union -> GCRA/cooldown rows is the lock order. No path acquires
the subject after a challenge/bucket lock. Resend retains its challenge-first
order and never acquires a subject lock.

A distinct outer `unicon_challenge_request` savepoint encloses coordination,
new challenge, INITIAL admission and all charges. Both returned business
denials and exceptions roll back candidate creation and all admission writes,
even if the owner commits earlier unrelated work. Successful CREATED/REUSED
results remain provisional until outer commit. No self-owned transaction,
automatic retry or uncertain-commit reconciliation is added. Confirmed aborts
remain eligible only for a fresh whole-owner transaction; unknown outcomes
must not trigger blind replay or refunds.

Unit and real PostgreSQL tests cover fixed proof/lifetime persistence, legacy
reuse, exact absence of reuse mutations, concurrent first requests and
replacements across clients, mixed initial/resend, inherited cooldown and
identity/IP GCRA debt, contradictory live rows, unchanged predecessors, owner
rollback, actual INITIAL insert failure caught by the owner, expiry during
subject/candidate waits, a new challenge's window closing during a bucket wait,
and injected 40001 abort followed by one committed INITIAL/charge. Migration
verification preserves synthetic legacy keys, timestamps, relations and hashes.
Block 4 adds durable operation reconciliation below. Global/backlog composition
and public HTTP eligibility/error mapping retain their later owners.

#### Iteration 4 block 4 — durable operation receipts and commit reconciliation

`AuthenticationOperationService` owns bounded READ COMMITTED transactions above
the existing SIGN_IN initial/replacement and RESEND composable methods. This is
an internal API; it does not define public HTTP headers, client ID minting or
authorization. The caller still validates institutional-email/domain eligibility
and resolves trustworthy source IP. Operation identity is never proof of email,
session authority or permission to retrieve another request's result.

The immutable v1 protocol permits repetition until issuedAt + 86400 seconds;
receipt retention ends another 300 seconds later. Neither reads/replays nor
worker transitions extend either boundary. These are protocol constants, not
runtime tuning values: increasing the accepted age after old rows were cleaned
could resurrect IDs. A future protocol change must preserve old-ID expiry.
`createOperationId` uses fresh primary-DB time and crypto randomness to create
a canonical UUIDv7 (48-bit epoch milliseconds, version/variant and 74 random
bits). `execute` rejects future timestamps and rejects age >= 24 hours even
when no receipt remains. It validates time after operation/receipt waits and
again after downstream domain/bucket waits, rolling back new work if the ID
expired while waiting. UUID time is an immutable part of this ID, not an
authenticated assertion that a client or device is trustworthy.

`AuthenticationOperation` is an additive receipt table with explicit kind,
outcome, timestamps, minimal challenge/Delivery references, admission microseconds
and denial metadata. There are no domain foreign keys: removing a challenge,
Delivery or subject cannot prematurely remove replay protection. SQL constraints
bind issuedAt to the UUID timestamp, fix both lifetime boundaries, require a
32-byte request digest and enforce result/denial shapes. No proof, envelope,
JWT, raw recipient/IP, provider key or arbitrary Prisma/JSON snapshot is copied
into receipts. The provider idempotency UUID remains separate and is stable
across confirmed-abort retries of one execute call.

Binding uses SHA-256 over versioned length-prefixed operation ID, action,
normalized identity or challenge ID, canonical source IP, template protocol and
RESEND retention deadline. Including the random ID avoids a stable fingerprint
across unrelated operations. This is request equality, not proof hashing or an
authentication secret; it has no HMAC-key rotation dependency. Equivalent IP
representations canonicalize before binding. Changing a bound input with the
same ID is OPERATION_CONFLICT; no old receipt is overwritten and no new work
is admitted. An internal RESEND retry must retain its original absolute
retention deadline, not compute a new one on every attempt.

The transaction first obtains an advisory lock derived from
`hashtextextended('unicon.auth.operation.lock.v1:' || operationId, 0)`, then reads
the receipt FOR UPDATE. This lock is acquired before subject, challenge,
Delivery and bucket locks, including when the receipt row is absent. A committed
receipt returns its validated historical result without running admission.
Otherwise admission and receipt insertion commit or roll back together. Only
confirmed PostgreSQL/Prisma aborts retry within the existing rate-limit
transaction bounds; each retry is a new whole transaction with fresh DB time.
The existing GcraAdmissionConfigService supplies finite timeout, connection-wait,
lock-timeout and maximum-attempt limits.

CREATED, REUSED, EXISTING and ordinary business denials are committed outcomes.
An ordinary denial still leaves no new challenge/Delivery/charges, while the
outer owner persists a DENIED receipt. Rate denial now propagates its original
operation time and exact first eligible integer microsecond: max of cooldown
boundaries and ceiling of rational GCRA eligibility. The receipt saves that
absolute boundary as finite integer NUMERIC, preserving the existing GCRA
range beyond signed 64-bit time; a value-preserving widening migration avoids
truncation or a narrower receipt limit. Replay computes remaining wait from fresh DB time, possibly
zero, but remains a historical DENIED decision; it does not pretend to be a
fresh quota check or silently become a successful send. A new explicit action
uses a new operation ID and passes all current checks. Stored success likewise
does not make expired/consumed proof usable or imply provider acceptance.

If callback completion is followed by an unconfirmed commit error, the owner
performs one read-only reconciliation transaction on the primary DB. It takes
the same operation lock before a fresh READ COMMITTED receipt read, waiting for
any original owner to commit/roll back. A receipt proves COMMITTED; locked
absence proves NOT_COMMITTED, without automatically repeating admission.
Failed reconciliation yields COMMIT_OUTCOME_UNKNOWN. No path refunds budgets,
invalidates proof or fabricates rollback based on transport failure. Explicit
`reconcile` uses the same context/age validation and never invokes admission.
Errors expose only safe reasons, without raw driver exceptions or causes.

Receipt cleanup uses short independent bounded transactions and FOR UPDATE
SKIP LOCKED, deleting only retention-expired rows. It does not touch domain or
rate tables and does not need their locks. The scheduler is non-overlapping,
unref'ed, stopped/drained at shutdown and degraded on DB failure with safe event
logging. Like Delivery cleanup it uses the existing challenge cleanup interval,
batch size and maximum batches per run. The 5-minute grace exceeds the configured
maximum transaction timeout; cleanup never intentionally shortens the accepted
retry window or depends on Delivery status.

Unit tests cover ID boundaries, replay/binding, retry classification, immutable
denials, unknown-commit decisions and bounded/non-overlapping cleanup/shutdown.
Real PostgreSQL tests cover concurrent duplicate operations, late receipt insert
failure and whole-owner abort/exhaustion, terminal/deleted domain records,
pending-owner reconciliation, absolute denial waits, cleanup/grace/SKIP LOCKED,
and expiry during both operation and downstream bucket waits. Lost commit
acknowledgement tests delegate real SQL transactions and commits/rollbacks and
simulate only transport acknowledgement delivery; they are not real network-
fault tests. Iteration 7 retains actual network/commit-fault injection and
capacity measurements. Block 5 below completes subject retention/finalization
and integrated verification. Public mapping and global/backlog integration
retain their later owners.

#### Iteration 4 block 5 — integrated lifecycle and subject retention

The challenge cleanup service fairly cycles three independently committed batch
phases: clear expired envelopes, delete retention-expired challenges (with the
existing Delivery cascade), then delete orphaned identified subjects. All three
share the existing batch size and maximum batches per run. A cursor survives
between runs so a budget of one does not starve any phase. Runs remain
non-overlapping and shutdown-drained; summary/log includes the orphan count and
failures log a safe event without raw database exception details.

`deleteOneOrphanedSubjectBatch` targets only rows with identified metadata.
It retains a subject whenever any challenge references its key, or a legacy
challenge has the same normalized identity/purpose. This includes expired or
terminal challenges still within retention. Anonymous legacy subjects are not
swept. The first READ COMMITTED statement locks candidate subjects in key order
with FOR UPDATE SKIP LOCKED. A second, fresh statement repeats both reference
checks: children committed before the lock must not be missed by an older
snapshot. Held parent FOR UPDATE locks prevent new FK children during deletion.
It never intentionally uses cascade to remove work and never modifies rate
state or operation receipts.

An empty subject can disappear after an initial request's ON CONFLICT DO NOTHING
but before SELECT FOR UPDATE. `lockSignInSubject` makes at most three insert/read
coordination attempts for that confirmed missing-row case only. It does not
retry database errors inside an aborted transaction, regenerate proof or repeat
admission. Confirmed serialization/deadlock aborts still belong to the outer
transaction owner.

`AuthenticationChallengeFinalizationRepository` runs in account finalization's
existing transaction under its User lock, before session deletion. It establishes the canonical
SIGN_IN subject even when absent, locks relevant subjects in key order, then
challenges in ID order. The deletion query scopes owned challenges by userId
and additionally matches unbound institutional SIGN_IN challenges for the
locked account's original email. Another user's bound record is not deleted
merely because its email matches. Empty identified subjects are removed only
after fresh FK and identity/purpose checks. Existing anonymous legacy rows
retain their prior behavior. Tombstone transition, challenge/Delivery deletion
and notification preparation remain atomic; later failure rolls back all of
them. Owned session-bound STEP_UP challenges are removed before Session's SET
NULL action can violate their purpose-binding constraint. This does not add
STEP_UP admission. Provider notification dispatch remains outside the transaction. Receipts
and identity/IP debt are preserved, not refunded or deleted with the account.

The User lock remains account finalization's existing prefix; within auth the
order is subject -> challenge -> Delivery/buckets. No admission path takes
User/subject locks after bucket locks. Retention phases use separate transactions
and orphan cleanup takes no child row locks, avoiding a cleanup
challenge->subject inversion. If initial commits first, Serializable finalization
retries confirmed snapshot conflicts as necessary and deletes pending old-account
work. If finalization commits first, a later request is a fresh sign-in intent
for the now-released email, subject to preserved limits; it does not reopen the
deleted account or create a User/Session without proof.

Integrated PostgreSQL tests use real operation/admission owners, proof factory,
repositories, limiter, worker orchestration, retention and account finalization.
Only external auth-email and notification-email integrations are fake. They
cover initial/reuse/resend, stable application-level submissions, expiry
replacement, inherited debt, late rollback, cleanup/replay, both orders of
initial/finalization, orphan SKIP LOCKED, the conflict/read deletion race and a
legacy reference committed between the two orphan queries. Boundary wrappers
only pause real SQL, never replace its results. Fifty INITIAL and fifty
interval-eligible RESEND admissions on one IP retain exactly 100 charges.
Historical interval/expiry fixtures are explicit; these are not elapsed-wall-
clock experiments or production-capacity measurements. The exact ten-Delivery/
fractional-recovery reference remains covered by GCRA arithmetic tests, with
production load/network-fault gates in Iteration 7.

This completes Iteration 4's internal Delivery admission/lifecycle scope. Public
HTTP, global/backlog capacity and the transitional OTP-lock removal retain their
later owners; this does not establish full passwordless readiness. Iteration 5
owns verification admission and its gated no-attempt-lock transition; Stage 5–6
own the public flow. Block 5 adds no schema change or data-rewriting migration.

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

Canonical OTP mismatches charge the accepted identity/IP verification policies.
They do not permanently lock the target challenge after any fixed attempt count.
Retained failedAttemptCount accounting must not gate eligibility or clear proof.
Concurrent checks cannot bypass GCRA capacity. The current Stage 2 implementation
still has its five-failure lock until the gated Stage 4 transition is delivered.

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

1. recheck purpose, lifetime, binding, consumption/terminal state, and applicable
   verification-policy eligibility;
2. verify and consume the proof;
3. resolve, create, or transition the user;
4. create the session and security events.

The challenge verification primitive is transaction-composable: it accepts a
Prisma transaction client, commits nothing and performs no retries. It captures
trusted canonical IP and expected purpose/session binding before the first
await, then locks the challenge with `SELECT ... FOR UPDATE`. Missing, incorrectly
bound, consumed, historically locked, expired and malformed inputs are excluded
from failure budgets. An early DB timestamp supports lifecycle expiry cleanup;
for canonical proof the limiter locks the full four-policy bucket union and
samples a fresh microsecond DB timestamp after all waits. That admission time
controls comparison eligibility, diagnostic accounting and consumption. Returned
Date timestamps use its millisecond representation; GCRA preserves exact rational
microseconds. A second expiry check after bucket waits prevents stale consumption.

Both canonical OTP and magic-link mismatches charge all four failure budgets and
increment the diagnostic count once. Malformed proof and other exclusions do
neither. Denial returns internal RATE_LIMITED with authoritative retry seconds,
absolute microsecond boundary and denied policy IDs, without comparing proof or
changing challenge/rate state. No count sets lockedAt, clears the proof envelope,
or cancels Delivery. Purpose, binding, expiry, consumption and historical terminal
state remain enforced. The expectedBoundSessionId input is explicit: null for
SIGN_IN, the authorized bound session for STEP_UP. It is not client assertion.

The verifier has its own single-entry ReadCommitted/Serializable transaction
guard and savepoint around challenge work; the limiter savepoint also includes
proof comparison and its diagnostic/consumption mutations. An error caught by
the owner cannot commit partial verifier changes. The owner supplies finite
transaction/lock bounds and any bounded whole-transaction retry after confirmed
abort. No external I/O belongs in comparison or these transactions.

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
and replacement after expiry, must share the applicable authoritative
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

Request new code after expiry checks the remaining interval since the
last Delivery admission; it does not start a fresh 60-second wait on click,
expiry or challenge replacement:

```text
00:00  initial Delivery A admitted; identity boundary = 01:00
00:05  five canonical wrong OTPs; target challenge A remains usable
00:06  Resend denied; retryAfterSeconds = 54
01:00  if other policies allow, Resend creates the next Delivery of A;
       identity and challenge A boundaries become 02:00
```

If 60 seconds have already elapsed since the last admission, expiry adds no
independent waiting penalty. Wrong OTPs do not offer a new-challenge bypass: a
repeated initial request resolves the same reusable challenge. A cooldown denial must not persist a replacement
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

Before Delivery charge, creation, or cooldown establishment,
check challenge lifecycle and remaining validity against Stage 3's configured
minimum validity required for submission (V1: 120 seconds). If remaining
validity is less than that minimum, deny next-Delivery admission. Closed
Delivery eligibility does not itself prohibit verification of still-live proof.
Cooldown never extends challenge lifetime.

Before new admission, serialize and resolve any existing unfinished Delivery
under the manual-resend rules above. Returning existing work does not charge
Delivery budgets or move cooldown. If no unfinished Delivery exists, applicable
atomic charges, new Delivery creation, and cooldown establishment succeed or
roll back together. Concurrent requests cannot create two unfinished Deliveries
for one challenge or bypass shared identity cooldown. No provider I/O occurs
inside admission. After commit, new PENDING work is available without a second
Resend action. Provider results never start, reset, or refund cooldown.

Passing admission does not authorize immediate provider submission. Temporary
lack of provider gate capacity alone does not deny Delivery creation when
admission and backlog permit accepting work. Preserve applicable provider waits
across Deliveries; do not bypass Retry-After by creating new work. Cross-Delivery
enforcement belongs to Iteration 6. Whether work can still be useful remains a
separate delivery-window/lifecycle admission check.

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

The former five-Deliveries/identity/hour target is superseded by the accepted
email Delivery GCRA below: burst 10, sustained rate 7/hour. This covers the
accepted ten-Delivery UX reference scenario without a fixed hourly reset.
IP Delivery GCRA is accepted with burst 120 and sustained rate 240/hour,
superseding the former twenty/hour target. The former twenty-verification-attempts/IP/15-minute
target requires reassessment under the accepted failure-only, independent
identity/IP policies below; it is not a fixed all-attempts limit. The former
five-failure challenge lock is superseded in the target by the decision below.
The consolidated register below closes Iteration 1 semantics; validated runtime
configuration and explicitly deferred capacity measurements remain later work.

### Stage 4 Iteration 1 — consolidated policy register

Status: **COMPLETE — policy semantics accepted; runtime implementation pending.**
This register summarizes the accepted decisions below, not additional policies.
Identifiers are documentation labels, not new public API codes or prescribed
code symbols. GCRA burst B means exactly B initial permissions, with independent
persisted state per policy/subject. Rates are replenishment, not fixed-window
quotas. PostgreSQL is authoritative across replicas; Redis is not required.

| Policy / protected resource | Canonical subject | Match / admission condition | Charge or occupancy condition | V1 algorithm / parameters | Implementation owner |
| --- | --- | --- | --- | --- | --- |
| Public passwordless requests / HTTP processing | Source IP + explicit public auth route group | Each request to the four covered POST routes, before JSON parsing | One per admitted HTTP request, regardless of downstream outcome | GCRA burst 200, rate 600/minute | Iterations 2–3; HTTP Stage 5–6 |
| Challenge Delivery cooldown / churn | Challenge ID | A genuinely new Delivery for this challenge | Establish boundary only with committed Delivery admission | Admission-anchored minimum interval 60 seconds | Iterations 2–4 |
| Identity Delivery cooldown / cross-challenge churn | Normalized institutional identity, shared across purposes | New Delivery even if challenge, client, or IP changed | Establish boundary only with committed Delivery admission | Admission-anchored minimum interval 60 seconds | Iterations 2–4 |
| Identity Delivery budget / email bombing | Normalized institutional email | New initial, RESEND, or replacement-initial Delivery | One per committed new Delivery; no provider-failure refund | GCRA burst 10, rate 7/hour | Iterations 2–4 |
| IP Delivery budget / source-driven email work | Canonical source IP | Same new-Delivery admissions | One per committed new Delivery | GCRA burst 120, rate 240/hour | Iterations 2–4 |
| Short identity verification / rapid guessing | Authoritative normalized identity | Eligible, correctly bound live challenge; all four verification policies allow | One per committed canonical OTP/link mismatch only | GCRA burst 6, rate 6/minute | Iterations 2–3 and 5 |
| Short IP verification / rapid source abuse | Canonical source IP | Same verification eligibility | Same committed mismatch only | GCRA burst 72, rate 72/minute | Iterations 2–3 and 5 |
| Long identity verification / sustained guessing | Authoritative normalized identity | Same verification eligibility | Same committed mismatch only | GCRA burst 8, rate 12/hour | Iterations 2–3 and 5 |
| Long IP verification / sustained source abuse | Canonical source IP | Same verification eligibility | Same committed mismatch only | GCRA burst 360, rate 360/hour | Iterations 2–3 and 5 |
| Global Delivery rate / aggregate creation | Whole auth admission scope | New Delivery creation | One per committed new Delivery | Numerical rate/burst and enforcement parameterization selected from measurements; no invented default | Iterations 6–7 |
| Auth Delivery backlog / outstanding work | Whole auth Delivery scope | Creation requires one free outstanding-work slot | PENDING + PROCESSING, including retry/capacity waits; terminal states release occupancy | Exact atomic capacity limit; numerical value after measurements | Iterations 4, 6–7 |
| Shared Resend send gate / provider submission capacity | Configured Resend team shared by all application send callers | Before every provider attempt, including retries and notifications | One granted submission permission; granted permission does not prove HTTP receipt | GCRA burst 1, rate 8/second; minimum spacing 125 ms | Iteration 6 |

#### Shared denial, transaction, and privacy rules

- Request charging commits separately before parsing/domain work; request denial
  advances no TAT and stops parsing. Malformed JSON charges no domain budgets.
- Delivery budgets, both cooldowns, global admission, backlog reservation, and
  creation compose atomically. Denial/confirmed rollback leaves no partial
  mutations. Resolve existing unfinished work without new admission or charges.
- Verification locks/validates authoritative challenge and all four buckets,
  checks eligibility before comparison, and commits canonical mismatch charges
  together as a normal result. Success, excluded outcomes, and policy denial
  advance no failure TAT. Technical failures before commit roll back this work.
- GCRA/cooldown denial has authoritative DB-backed retry-after; combine applicable
  denying eligibility times without HTTP-layer recalculation. Global outcomes
  distinguish GLOBAL_RATE_DENIED, DELIVERY_CAPACITY_UNAVAILABLE (unknown release
  time), and INFRASTRUCTURE_FAILURE. Uncertain commit requires reconciliation or
  safe idempotent retry, not a claim of rollback or blind duplicate admission.
- Provider-capacity waiting defers work without a fake provider failure or
  processing-attempt charge. Preserve Retry-After across Deliveries. Temporary
  gate exhaustion alone does not deny otherwise admissible new work.
- Raw email/IP and proof never enter rate-limit bucket persistence. Derive opaque
  keyed identifiers with policy/domain separation and canonical characteristics;
  active protection survives key/config changes and safe cleanup. Challenge IDs
  are internal characteristics, not public telemetry labels. Persist global/team
  state without leaking secrets; use bounded aggregate metrics. Fail closed on
  required enforcement failure, independently of optional telemetry availability.

#### Eligibility and lifecycle invariants, not additional quota buckets

Challenge lifetime is 600 seconds with stable OTP/link and shared atomic
consumption. New Delivery admission requires at least 120 seconds remaining
validity; submission rechecks eligibility after waits. There is at most one
PENDING/PROCESSING Delivery per challenge under concurrency. Repeated initial
resolves a reusable challenge without automatic Delivery; Resend resolves
unfinished work without supersession, retry/lease changes, new quota charges,
or cooldown movement. New work after terminal Delivery still passes all checks.
The accepted removal of the five-failure OTP lock is gated on integrated,
verified, fail-closed verification enforcement; historical terminal rows are not
reopened. These are target changes, not claims about current Stage 2/3 runtime.

#### Explicit deferred work — not reopened Iteration 1 questions

| Work | Owner / completion gate |
| --- | --- |
| Dedicated key ownership, canonical encoding, rotation preserving active debt, strict IP parser implementation, validated configuration and replica rollout/active-TAT semantics | Iteration 2, before affected enforcement is enabled |
| GCRA TAT persistence/schema needs, lock order, exact arithmetic, bounded transaction retries and safe expiry | Iterations 2–3, database-backed verification |
| Transaction-composable Delivery repository, one-unfinished invariant, admission reconciliation/idempotency and concrete operation identity | Iterations 4/6, verified in Iteration 7 |
| Verification integration, legacy OTP-lock/schema transition | Internal integration/transition complete in Iteration 5 after concurrency, rollback, fail-closed and retention checks; real network/load validation remains Iteration 7 work |
| Global rate algorithm parameterization and numeric rate/burst/backlog values | Iterations 6–7 measurements before production; preserve accepted denial/atomicity contracts |
| Gate/claim/defer composition, notification deferral, permission/crash accounting, provider daily/monthly quota handling | Iteration 6, integration verification in Iteration 7 |
| HTTP mappings, source-resolution failures, combined-error precedence, response fields and retry UX | Stages 5–6; no undocumented public fields added here |
| Exact proxy ranges/header contract, topology and origin-bypass checks | Before staging on selected hosting; preserve accepted direct/proxy-only boundary |
| Full capacity/fault tests and p99 request-to-acceptance measurements; pilot tuning | Iteration 7 and Stage 5–6 HTTP integration, before production rollout |

The measurement plan below defines bursts 10/50/100/500 and an ambitious
normal-load p99 below one second to provider acceptance. It does not claim
subsecond burst completion, mailbox-arrival guarantees, or completed tests.
No device/install buckets, composite verification buckets, prefix-IP policies,
CAPTCHA requirement, weighted engine, or future non-auth policies are added by
this register. Notifications/session-management decisions remain their owning
later stages and do not expand Stage 4 implementation scope.

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

A verification-policy denial does not itself increment failedAttemptCount or
perform a proof lifecycle transition. Stage 4 Iteration 5 block 2 replaces the
five-wrong-OTP runtime lock with integrated four-policy verification admission.

### Accepted verification characteristics and failure-only accounting

Status: **ACCEPTED / FIXED**; internal enforcement is implemented in Stage 4
Iteration 5 block 2. Public HTTP wiring remains Stage 6 work.

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
| Canonical wrong OTP for an eligible, correctly bound challenge | Charge both | Diagnostic increment if retained; no target attempt lock |
| Canonical wrong magic-link token for an eligible, correctly bound challenge | Charge both | Unchanged |
| Successful proof | No charge | No failure increment |
| Malformed proof | No charge | Unchanged |
| Missing challenge | No charge; identity cannot be derived | Unchanged |
| Already locked, expired, or consumed challenge | No charge | No new failure increment |
| Wrong purpose or invalid binding | No charge | Unchanged |
| Infrastructure/configuration/internal error | No proof-failure charge | No fabricated proof failure |
| Verification-policy denial before proof checking | No new proof mismatch | Unchanged |

The fifth and later canonical wrong OTPs are chargeable mismatches if the
challenge is still eligible and all verification policies allow the check.
Failure number alone does not make it terminal in the target. Requests to a
historical terminal/locked challenge are not further proof mismatches. Correct
proof arriving after expiry/consumption does not become a wrong proof. Preserve
expiry cleanup and consumption; retire only the legacy attempt-count lock and
its self-heal through the gated transition below.

Excluded outcomes are not exempt from request protection. Provide independent
request-level controls for malformed input, missing/terminal challenges,
purpose/binding rejection, and other traffic, including requests rejected before
proof verification. Successful requests may also be accounted for there. Do not
accept a client-supplied email to charge an unknown challenge's identity bucket.
No specific request thresholds or HTTP outcome mapping are chosen here.

Repeated magic-link clicks must not exhaust verification failure budgets when
they carry the valid proof or refer to a consumed/expired challenge. Successful
verification does not charge failure TAT; subsequent replay/terminal rejection
is not a mismatch. Serialize concurrent valid link/OTP exchanges so at most one
can consume and create a session; losing requests must not be recorded as wrong
proofs or create additional sessions. Do not make replay return stored raw
session tokens. The client prevents duplicate in-flight POSTs and retry loops;
GET/prefetch alone never submits verification. Every actual HTTP request may
still spend separately configured request capacity. Canonical wrong tokens for
eligible challenges remain genuine chargeable failures even when repeated; do
not exempt repeated invalid proofs as a blanket click-recovery measure.

#### Accepted V1 short-term verification — GCRA

Status: **ACCEPTED / FIXED**; configurable internal enforcement is implemented
in Iteration 5 block 2, with public HTTP wiring pending. GCRA replaces the previously selected short-term fixed
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
retain that charge for success. Compose admission, proof checking, and committed
charges under the accepted verification transaction boundary below.

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
Iteration 5 block 2 uses GCRA and independent lifecycle/Delivery rules without
an attempt-count lock. Historical terminal records remain terminal.

Accepted OTP and magic-link mismatches share each scope's budget across
challenges. Successful proof consumes neither. Failures do not automatically
lock the target challenge; rate recovery does not extend its lifetime or reopen
a terminal challenge. A replacement
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

Preserve cryptographic/single-use/expiry semantics and independent Delivery
budgets. The accepted request scope and verification transaction boundary below
fix policy behavior; concrete integration and recovery design belong to their
implementation iterations, as listed in the consolidated register.

#### Accepted V1 long-term identity verification — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 policy values for later
tuning from operational analytics; internal verifier enforcement is implemented
in Iteration 5 block 2, with public HTTP wiring pending.

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

For risk comparison only, with idle buckets, no other blockers, and the target
challenge without an attempt-count lock, combined identity policies permit
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
risk than the former lock, rather than demonstrating that the lock had no value.

This risk trade-off is accepted for the target recovery UX in the decision
below. Iteration 5 block 2 implements this transition in the internal verifier.
Six-digit proof, 600-second lifetime, and independent Delivery limits remain.

#### Accepted V1 long-term IP verification — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 policy values, subject to
later tuning from aggregate operational data; internal enforcement is implemented
in Iteration 5 block 2, with public HTTP wiring pending.

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
resend by itself. Iteration 5 block 2 implements the removal gate below with
internal verifier concurrency, rollback, fail-closed and state-retention checks.

Apply shared GCRA authoritative-time, concurrency, opaque-key, privacy,
configuration/rollout, safe-cleanup, and telemetry requirements. Size and tune
from legitimate shared-network failures as well as abuse: a busy or attacking
client on a shared IP can consume capacity needed by others. Successful checks
consume no failure capacity, but are still covered by independent request
protection. No new request/Delivery/global/provider parameters are selected here.

### Accepted verification transaction boundary

Status: **ACCEPTED / FIXED; limiter core and internal verifier integration
implemented in Stage 4 Iteration 5 blocks 1–2.**

`AuthenticationVerificationRateLimitService.evaluateInTransaction` composes the
four fixed verification policies with the existing GCRA repository, key
derivation, exact arithmetic and shared transaction savepoint. The owner must
resolve and lock the authoritative challenge and validate canonical input,
purpose/binding and terminal eligibility before calling it. Identity and captured
expiry come from that challenge. The helper locks all retained bucket aliases,
reads state and samples one DB microsecond timestamp after serialization waits.
It rechecks expiry before admission/comparison. Denial returns the latest absolute
eligibility boundary, rounded retry seconds and policy IDs, without invoking proof
comparison or changing aliases.

The internal callback receives that timestamp and returns MATCH,
CANONICAL_MISMATCH or EXCLUDED. It must perform no external I/O. Only canonical
mismatch writes all four policy states at that timestamp; all charges are
calculated before the first write. Success/exclusion/expiry/denial neither advance
TAT nor repair missing aliases. Errors roll back the savepoint including callback
database mutations; a mismatch remains a normal result for the owner to commit.
The helper opens no transaction, commits nothing and performs no retries. Shared
guards require a caller-owned ReadCommitted/Serializable transaction and one
limiter operation per transaction. The owner supplies finite transaction/lock
bounds and any bounded retry of confirmed aborts. Block 2 integrates this core
with the challenge verifier and consumption, removes attempt thresholds from
request/Delivery paths, and retains diagnostic counts and historical lockedAt.
User/session issuance and public HTTP integration remain later-stage work.

Iteration 5 block 3 verifies the mitigation boundary through real PostgreSQL
service chains (`test/authentication-verification-lifecycle.e2e-spec.ts`). A
verification-policy denial neither creates replacement proof on reuse nor stops
existing Delivery resolution or eligible resend. The worker sends the original
OTP/link; new Delivery admission changes only its own GCRA/cooldown state and
remains subject to its own interval, validity window and budgets. Verification
debt survives actual request-driven expiry replacement and challenge retention
cleanup; old operation-receipt replay never repeats admission. Recovered
short-term capacity leaves long-term restrictions intact. Separately committed
request accounting is preserved across verification results and rollback.

These tests use real crypto, repositories, operation receipts, transaction owners,
rendering, worker persistence and cleanup, replacing only the external email
provider. The internal request service's institutional-email eligibility remains
an owner precondition; public validation/guard wiring is not claimed here.
Explicit historical cooldown/expiry and partial-recovery bucket fixtures isolate
the boundaries without claiming elapsed wall time or production load. The actual
timed same-challenge recovery test remains in block 2. Block 3 adds tests and
documentation only. Block 4 completes internal concurrency/failure closure below.

Iteration 5 block 4 adds 12 PostgreSQL checks in the lifecycle suite, using two
independent DB clients and observing actual lock waits before releasing the first
owner. Both verification/resend orders preserve mismatch proof or enforce
consumption; resend created before consumption is cancelled by the worker before
provider submission. Both verification/expiry-replacement orders leave the new
proof independent and preserve identity/IP debt. Cleanup skips verifier-held
rows; a test-only PostgreSQL trigger pauses actual retention deletion while it
owns the row, proving that waiting verification resolves NOT_FOUND after commit.

Test-only final-write SQLSTATE 40001/40P01 injection exercises the integrated
verifier and whole-owner rollback/retry. The failed owner leaves no diagnostic,
partial bucket charge or owner marker; the new attempt commits one diagnostic
and one charge per policy at one admission time. A simulated caller
acknowledgement failure after commit is not a confirmed abort and is not blindly
retried. Actual transport/commit-ambiguity fault tests remain Iteration 7 work.

The shared-IP check runs canonical OTP/link mismatches for 90 distinct identities
through the real verifier across two clients. Temporary transactional SQL audit
rows observe committed IP TAT and the diagnostic timestamp's one-millisecond
admission-time interval, validating eligibility and exact charge bounds in actual
serialization order. It allows genuine replenishment during the batch; exact
72-at-one-instant arithmetic remains covered by the common GCRA tests. A separate
future-boundary fixture verifies denial without partial identity charges or IP
state movement. No service, crypto implementation or clock is replaced. These
checks establish internal behavior, not production throughput or a general proof
that every possible interleaving is deadlock-free.

Stage 4 Iteration 5 is complete for internal verification admission and the
legacy attempt-lock transition. Block 4 changes tests/documentation only. Public
HTTP integration and user/session issuance remain Stage 5–6 work; production
capacity/network-fault and later cleanup gates remain in Iterations 6–7.
The older retention lifecycle test also uses explicit DB-clock expiry/retention
fixtures, avoiding an application-clock Date.now()-1ms cutoff for DB cleanup.

The complete integration target remains: use one short PostgreSQL
transaction for verification abuse admission, proof comparison, and the resulting
proof/domain mutations. Serialize the challenge and all applicable verification
buckets in deterministic order, then obtain fresh DB-authoritative time after
required serialization waits. The concrete lock order and composition with the
Stage 2 primitive are implemented in Iteration 5 blocks 1–2; do not reuse a
timestamp that predates
subsequent bucket-lock waits.

For an eligible, correctly bound live challenge, all four GCRA verification
policies must allow the operation before comparing proof. If any denies it,
do not compare proof or advance any failure TAT. Canonical wrong proof atomically
advances all four failure buckets and any applicable retained diagnostic counter.
Return WRONG_PROOF as an internal result value and commit before mapping the
HTTP error; never throw an ordinary mismatch inside the transaction and thereby
restore its abuse capacity. Successful proof does not advance failure TAT;
consumption and auth mutations use the same transaction and retain the Stage 2
single-consumption and explicitly classified business-outcome commit contracts.
Malformed, missing, expired, consumed, otherwise excluded outcomes, and policy
denial do not charge verification failure budgets. Existing lifecycle cleanup
may still follow its own transaction semantics.

A technical/internal failure before commit rolls back the entire transaction:
no partial failure-bucket charges, diagnostic increments, consumption, or domain
mutations may survive. Do not proceed without authoritative limiter state. A
committed wrong-proof result remains charged even if the HTTP response is lost.
Concurrent requests cannot all pass stale bucket state or create multiple
sessions from one challenge. Keep external provider/notification I/O outside the
transaction. Request-level charging is committed separately before domain work
and is not refunded by verification denial, failure, or rollback.

### Accepted removal of automatic OTP attempt lock

Status: **ACCEPTED / FIXED; internal transition implemented in Iteration 5
block 2. Public HTTP/client integration remains Stage 6 work.** Supersede the
five-wrong-canonical-OTP permanent challenge lock. Verification is controlled by
the four accepted GCRA policies. When capacity is unavailable, return a stable
429 with authoritative retry-after; the client disables verification submission
and shows the remaining wait. When capacity returns, the same challenge/proof
can be verified if still live, correctly bound, and unconsumed. Do not force a
new challenge or email merely because of incorrect OTPs. The UI is explanatory;
the backend independently enforces admission for every request.

Wrong OTPs must not set lockedAt, trigger maximum-attempt self-heal, clear the
proof envelope, or cancel Deliveries solely due to a failure threshold. Keep
cryptographic validation, fixed 600-second expiry, stable resend proof, atomic
single-use consumption, purpose/session binding, explicit invalidation, and
existing terminal state checks. Expired challenges require a new-code flow;
repeated initial requests for a reusable live challenge still reuse it. Never
silently reopen previously terminal locked challenges during migration.

This explicitly accepts the modeled increase from five to at most nine guesses
for one ten-minute uniform six-digit proof with idle budgets: 0.0005% to 0.0009%,
subject to the enforcement assumptions above. It is a UX/security trade-off, not
proof that the old lock provided no protection or a system-wide risk guarantee.
Monitor failures/denials and tune operational policy from production evidence.

Implementation gate: keep the existing runtime lock until atomic, database-backed
four-bucket GCRA admission/charging is integrated with proof verification and
passes concurrency, failure/rollback, fail-closed, and cleanup/state-retention
checks. Do not remove the lock in an earlier standalone patch that permits
unthrottled verification. Authoritative limiter infrastructure failure is
fail-closed: do not proceed with verification/session issuance when required
eligibility or committed failure accounting cannot be established. Distinguish
technical unavailability from ordinary policy denial; do not fabricate 429 or
retry-after, lock the challenge, or classify a technical failure as wrong proof.
Atomic rollback must preserve pre-transaction proof/domain state; recovery never
extends TTL. Exact technical HTTP mapping remains Stage 5–6 work. Metrics/export
failure alone is not limiter-state failure and does not change enforcement.
Plan the transition in Stage 4 Iterations 3 and 5; public HTTP/client integration
follows in Stage 6.

Review maxAttempts/failedAttemptCount/lockedAt roles, check constraints, proof
clearing, verification and Delivery eligibility, cleanup, configuration, errors,
events, and dependent tests together. Use a new additive/transition migration as
needed and regenerate Prisma; historical migrations stay immutable. Retained
failure counts are diagnostics rather than eligibility thresholds. The exact
retention/removal of legacy fields is an implementation design decision. Do not
reset identity/IP TAT when replacing challenges or changing the schema.

Implementation: the new transition migration first terminalizes only legacy
unconsumed/unlocked rows with failedAttemptCount >= their old maxAttempts and
clears those envelopes, then removes maxAttempts and replaces its bounded-count
CHECK with failedAttemptCount >= 0. Existing locked/consumed/healthy rows remain
unchanged; no GCRA rows are changed. This intentionally removes obsolete threshold
metadata and requires a coordinated deployment: old application instances query
maxAttempts and cannot run against the new schema. The Prisma client is regenerated;
historical migrations remain immutable. Tests replay the historical table and
this actual transition SQL in an isolated PostgreSQL schema.

Required coverage: fifth and later OTP mismatches do not terminalize the target
challenge; GCRA denies while proof remains intact; retry-after elapses and correct
proof succeeds on that same challenge without another email; time expiry during
waiting still rejects; correct proof remains single-use; mixed OTP/link and
cross-challenge concurrency cannot overspend budgets; provider/Delivery behavior
retains stable proof and independent processing-attempt budgets.

### Bucket key derivation and rotation

Iteration 2 provides `RateLimitBucketKeyService` in the common `RateLimitModule`,
outside Auth. Auth domain and HTTP request owners declare fixed policy IDs and
characteristic kinds in their respective constants. The common service knows
only policy ID plus one `IP`, `IDENTITY`, or `CHALLENGE_ID` characteristic; it
does not implement admission, counters, quota selection, or arbitrary rule DSLs.

Protocol v1 is immutable. HMAC-SHA-256 takes four UTF-8 fields in this order,
each prefixed by its unsigned 32-bit big-endian byte length:

```text
unicon.rate-limit.bucket.v1
policy ID
characteristic kind: IP, IDENTITY, or CHALLENGE_ID
canonical characteristic value
```

An IP is canonicalized through the strict shared single-literal parser. Identity
must already be nonempty, trimmed, lowercase, free of control characters, and
losslessly representable as UTF-8. HTTP email/domain validation and authoritative
identity selection remain the caller's responsibility; derivation does not
silently normalize identity or resolve accounts. Challenge ID must be a
canonical lowercase UUID. Invalid input throws a technical/internal error without
echoing its value; there is no unknown-source fallback bucket.

The persistence key is `rl:v1:k<keyVersion>:<64 lowercase hex HMAC digits>`.
Only protocol/key versions and the opaque digest appear in that key. Raw
identity/IP/challenge values, purpose, endpoint, policy parameters, and deployment
versions are absent from the returned key set. For identity policies, changing
challenge, purpose, client or IP cannot change that identity's key. Policy IDs
and characteristic encodings are persisted protocol inputs: renaming either is
a state migration, never a harmless refactor. Incompatible protocol changes
also require a state-preserving transition before enforcement.

`RATE_LIMIT_HMAC_KEYS` is a versioned base64 keyring with exactly 32 bytes per
key; `RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION` is a positive safe integer referencing
that keyring. Startup rejects duplicate versions, duplicate rate-limit key
material, and reuse of any active or retained challenge hash/encryption key,
JWT secret, or legacy recovery/deletion rate-limit secret. As well as raw secret
bytes, copying the same base64 key text into those secret settings is rejected.
Examples contain placeholders; test fixtures contain public synthetic keys only.

The service privately snapshots the keyring and returns one immutable set of
bucket keys, sorted by numeric key version, with the active version marked
separately. It never returns only the active bucket. This output order is not a
database locking-order prescription. All applicable retained versions must
participate in authoritative enforcement; selecting only the active one would
permit a fresh-bucket bypass.

Required rotation sequence for the future limiter:

1. Provision the new key alongside every still-applicable old key, without
   changing existing version-to-material mappings. Keep the active version old
   while preparing the coordinated rollout. Drain protected admissions and
   in-flight transactions when changing the participating key set; all serving
   replicas must agree before admission resumes.
2. Under one atomic operation, lock/read all applicable aliases. Treat them as
   representations of one policy/subject, not independent allowances or summed
   historical charges. Preserve the latest applicable cooldown boundary and
   GCRA restriction. A missing new alias does not mean idle capacity when an
   old alias still restricts the operation. The exact alias reconciliation,
   charge/mirroring and debt-storage arithmetic belong to the PostgreSQL limiter
   implementation, with denial and failure rollback semantics preserved.
3. Promote the active version only after every serving replica accounts for
   all retained aliases. Promotion changes neither old derived keys nor their
   applicability. A new active version alone never grants capacity.
4. Retire old material only after all old-only writers and transactions are
   gone and a database-backed transition proves every still-applicable old
   restriction is preserved by retained state, or has become safely idle.
   Challenge expiry, Delivery retention, application restart, and a guessed
   rotation grace period are not evidence that cooldown or GCRA debt ended.

This block implements derivation and startup configuration only. It cannot
prove that deleting a key is safe by inspecting the configured keyring. Rotation
of enforced state, alias reconciliation, cleanup safety, concurrency and rollback
remain database-backed implementation/test gates before enabling protection or
retiring keys. No schema migration or limiter enforcement is included here;
the legacy OTP lock remains in force.

### Exact GCRA state persistence and arithmetic

Iteration 2 stores GCRA separately in `GcraRateLimit`; the existing
`AuthenticationRateLimit.count/windowEndAt` keeps its admission-anchored
cooldown meaning. The new table has an opaque bucket key, bounded policy ID,
the policy snapshot (`burst`, `rate`, `periodSeconds`), and a rational TAT:
`tatNumerator / tatDenominator` in microseconds since Unix epoch. Both rational
components use unrestricted PostgreSQL `NUMERIC` with checks for finite integer
values, nonnegative numerator and strictly positive denominator. This avoids
both binary floating-point error and the implicit rounding of `NUMERIC(p, 0)`.
Policy snapshot fields are positive safe integers stored as `BIGINT`.

Application arithmetic uses `bigint` fractions reduced by GCD. The interval is
exactly `periodSeconds * 1_000_000 / rate`; `Date` and JavaScript `number` never
carry TAT or enforcement timestamps. The future limiter must obtain integer
microsecond DB time after its required locks, e.g. from one `clock_timestamp()`
sample; converting that timestamp through JavaScript `Date` would discard
precision. This patch supplies arithmetic and storage only, not that lock/time
orchestration.

Eligibility is `t >= TAT - (burst - 1) * interval`, with exactly `burst` initial
unit admissions. A charge computes `max(TAT, t) + interval`; evaluation alone
does not mutate state. Public retry-after is the positive rational wait rounded
up to whole seconds. Success/excluded verification outcomes never invoke charge.
The arithmetic returns integer retry seconds as `bigint`; future HTTP mapping
must convert without numeric overflow, not silently truncate it.

`idleAfterMicros` is the exact integer ceiling of TAT. A SQL check binds it to
the rational components via integer quotient/remainder, not rounded decimal
division, and an index supports later cleanup. Deletion is safe only when fresh
DB time reaches this full-recovery boundary, rechecked under the same locking
protocol as admission. The earlier next-eligibility boundary is not full recovery.
Neither challenge expiry nor Delivery retention determines GCRA cleanup. No
cleanup worker is enabled by this patch.

An evaluator rejects a stored/configured policy mismatch as technical failure;
it never silently reinterprets debt. Parameter transitions use an explicit pure
retuning operation, to be applied only under the coordinated DB/replica rollout
contract. For active state at transition time t, define:

```text
oldInterval = oldPeriodMicros / oldRate
newInterval = newPeriodMicros / newRate
oldDebtUnits = (oldTAT - t) / oldInterval
newDebtUnits = oldDebtUnits + max(0, newBurst - oldBurst)
oldEligibleAt = oldTAT - (oldBurst - 1) * oldInterval
newTAT = max(
  oldTAT,
  t + newDebtUnits * newInterval,
  oldEligibleAt + (newBurst - 1) * newInterval
)
```

This conservative transition preserves at least the old time debt, outstanding
unit debt, current denial boundary, and no more immediately available unit
capacity. Looser settings do not immediately refund active protection; stricter
settings can increase waiting. Once TAT is reached, the bucket is fully idle
and the new policy can take effect without manufacturing recovery. This is an
explicit tuning rule, not an automatic per-request policy migration.

Retained aliases must have matching policy snapshots before reconciliation.
The pure reconciliation operation takes the latest exact TAT, not the sum of
alias histories; a missing new alias cannot erase an old restriction. Iteration 3
must atomically lock/read/reconcile and mirror a committed charge to all retained
aliases. This patch tests stored state, exact arithmetic, alias reconciliation,
schema constraints, and rollback against PostgreSQL. It does not establish
concurrent admission, replica coordination, key-retirement safety, HTTP behavior,
or integration with verification. The legacy OTP lock remains unchanged.

### Iteration 3 single-policy atomic GCRA admission

The first Iteration 3 block implements `GcraAdmissionService.consume` in common
rate-limit infrastructure. It owns one independent unit-charge transaction for
one explicitly selected internal policy/characteristic and every retained key
alias. The first intended consumer is public HTTP request accounting; no HTTP
middleware or auth domain flow is connected by this block. This method charges
on admission and must not be used directly for failure-only proof verification.
It cannot compose several policies by making several independent calls. The
multi-policy and externally owned transaction paths are implemented below.

The service captures validated policy inputs and derives all retained keys
before opening a `READ COMMITTED` transaction. It acquires transaction-level
advisory locks for existing and absent aliases. Each lock ID is PostgreSQL
`hashtextextended('unicon.rate-limit.lock.v1:' || bucketKey, 0)`; distinct actual
signed 64-bit IDs are acquired in ascending numeric order, not key-version or
text-key order. Hash collisions can cause extra serialization, never additional
capacity. Every participating writer and future cleanup must follow this same
protocol. Multi-policy work must acquire its entire lock union in one order.

After advisory locks, existing alias rows are selected in key order with
`FOR UPDATE`. Only after both advisory and row-lock waits does the service sample
one `clock_timestamp()` as integer microseconds. `READ COMMITTED` ensures the
row read sees committed work from prior lock owners; a transaction-start snapshot
or timestamp must not be reused across those waits.

Stored policy IDs, policy snapshots and exact state must be valid. A mismatch
is a technical failure, without implicit tuning or state repair. Matching aliases
reconcile to the latest exact TAT. A denying evaluation returns one authoritative
integer `retryAfterSeconds` without insert/update, missing-alias repair, TAT or
`updatedAt` changes. An allowed evaluation writes the same single-charge state
to every retained alias in the transaction. The result is returned only after
the owning transaction resolves successfully. No raw subject or key is returned.

Operational settings are required startup-validated configuration:

```text
RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS = 3 (allowed range 1..5)
RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS = 5 (allowed range 1..60)
RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS = 2 (allowed range 1..60)
```

Prisma transaction timeout/max-wait use these values; PostgreSQL's transaction-
local `lock_timeout` uses the same timeout setting. Only confirmed rollback
conflicts (`P2034`, or PostgreSQL `40001`/`40P01` through the supported adapter
wrappers) may retry, within the attempt bound, with new locks, reads and DB time.
No connection error, constraint error, timeout, generic error message or unknown
commit result is retried. Exhaustion is technical unavailability, not policy
denial. Internal failure reasons distinguish invalid input/state, unavailable
state, exhausted retries and unknown commit outcome. They retain no raw database
error/cause, query, subject or key; public error mapping remains Stage 5–6 work.

If the transaction callback completed but commit acknowledgement fails without
a confirmed abort, the result is `COMMIT_OUTCOME_UNKNOWN`. Do not claim rollback,
refund, or repeat it blindly. This block has no durable operation identity and
does not establish domain admission reconciliation/idempotency for Delivery.

Unit tests exercise bounded retry/error classification, configuration and a
simulated lost commit acknowledgement. PostgreSQL tests use real services and
independent Prisma clients for absent-row burst concurrency, accepted request
policy arithmetic over actual DB timestamps, subject independence, retained and
missing aliases, denial immutability, actual advisory/row-lock waits, incompatible
state, partial-write rollback, injected database abort retries/exhaustion,
lock timeout and backend connection loss. Test-only SQL triggers and sequences
inject aborts; they are removed by each test. These are correctness checks, not
production capacity measurements or real network-fault coverage around commit.

The later Iteration 3 blocks below add multi-policy composition and cooldown
admission. Cleanup, coordinated tuning/key retirement, Delivery/verification and
pre-parser HTTP integration retain their later owners. The legacy OTP lock
remains unchanged until its gated replacement.

### Iteration 3 multi-policy and composable GCRA admission

`consumeMany` checks and charges one complete set of distinct internal GCRA
policies in a single owned transaction. Existing `consume` delegates to this
path with one policy and preserves its original result shape. Empty sets and
repeated policy IDs, even with different characteristics or settings, fail as
`INVALID_INPUT` before an owned transaction starts. V1 admits one characteristic
per policy per operation; duplicates do not imply weighted cost or multiple
charges. There is no new policy DSL, schema or environment setting.

All policy inputs are captured before waiting. The service locks the complete
union of retained aliases once, in the existing actual-advisory-ID order, then
locks/reads all existing rows and obtains one fresh DB timestamp. Every policy
is validated and evaluated at that same time before any charge. An incompatible
later policy is a technical error even when an earlier policy already denies;
it is not hidden behind a fabricated ordinary denial. On denial, no policy or
alias is mutated or repaired. The result contains one authoritative retry-after
(the maximum wait among denying policies) and sorted internal `deniedPolicyIds`
for consistent overlapping-denial attribution. These IDs are not new public API
fields. On allowance, every policy is charged once and all its aliases are
updated. Partial writes roll back as a unit; owned retries repeat the whole set.

`consumeManyInTransaction` applies the same operation to a caller-owned Prisma
interactive transaction. Its result is provisional until that owner commits.
It never opens another transaction, commits, or retries. Real interactive scope
is required; root clients are rejected, and the operation's SAVEPOINT also fails
closed outside a real transaction. Supported isolation levels are READ COMMITTED
and SERIALIZABLE. READ COMMITTED sees prior lock-owner commits; SERIALIZABLE
may abort on an older owner snapshot and requires a fresh whole transaction.
Unsupported isolation and a second call with the same transaction client fail
as `INVALID_TRANSACTION`. Supply the complete GCRA set in one call; do not acquire
policy groups incrementally or issue concurrent commands on that client while
the call is in progress. The surrounding domain must follow its agreed global
entity/bucket lock order.

The caller owns finite transaction/connection-wait/DB-lock timeouts, bounded
whole-transaction retries and commit-outcome handling. The existing
`GcraAdmissionConfigService` is exported for using the same operational bounds.
This method does not change the caller's timeout settings. Known aborts are
sanitized as `TRANSACTION_ABORTED`, recognized by
`isRetryableGcraTransactionError`; retry only after the outer transaction has
rolled back, never inside its existing callback. Unknown commit outcomes remain
the outer owner's responsibility and must not trigger blind replay or refunds.

A reserved `unicon_gcra_admission` savepoint brackets the composable operation.
On failure, its writes and acquired post-savepoint locks are rolled back before
the safe error propagates. This prevents partial limiter writes from surviving
when an owner catches an error and commits earlier unrelated work. On success
the savepoint is released; a later outer failure still rolls back all charges
and caller mutations. A denial changes no limiter data, but the owner remains
responsible for its domain's commit/rollback rules for earlier mutations, such
as not committing a replacement challenge without initial Delivery. This helper
does not implement Delivery admission or its operation reconciliation.

PostgreSQL tests cover joint allowance, one or overlapping denials without
partial charge/repair, latest retry-after, incompatible state after a denial,
overlapping A+B/B+C policy sets in reversed input orders, all retained aliases,
time after the full lock union, operation-level savepoint rollback, provisional
results and caller-owned commit/rollback, invalid transaction usage and
whole-owner SERIALIZABLE retries. The same suites retain single-policy,
timeout, failure and persistence coverage with real Prisma services and clients.
Cooldown composition is implemented in the next block below. Failure-only
verification charging, HTTP/domain integration, automatic tuning and key
retirement retain their later owners.

### Iteration 3 atomic Delivery cooldown and GCRA checks

`AuthenticationDeliveryRateLimitService.admitInTransaction` is an internal,
auth-specific caller-owned operation for genuinely new Delivery work. It checks
exactly four existing policies: challenge and identity Delivery cooldowns,
identity Delivery GCRA and IP Delivery GCRA. The caller supplies the authoritative
challenge ID and normalized identity, plus the resolved source IP. Lifecycle,
minimum remaining Delivery validity, existing unfinished work, replacement
challenge persistence and actual Delivery creation remain Iteration 4 work.
This helper is not connected to HTTP or the provider and does not by itself
establish complete Delivery admission.

The operation derives all retained aliases before waiting, acquires their entire
advisory-lock union once in the common numeric lock order, then locks existing
`GcraRateLimit` rows followed by `AuthenticationRateLimit` rows, each in key
order. One fresh DB timestamp is sampled after all waits. It shares the existing
GCRA preparation/evaluation and savepoint handling; there is no additional
policy framework. The one-operation-per-transaction guard is shared with
`consumeManyInTransaction`, so callers cannot incrementally acquire policy
groups through separate limiter calls in one transaction.

Each cooldown alias must have count=1 and a finite boundary. Invalid state is
a technical failure even if another policy denies; no implicit repair occurs.
The latest retained boundary is authoritative, including an older key alias
missing from the new active version. Configuration changes do not shorten an
existing wait. At exactly the boundary admission is eligible. A denial returns
the maximum rounded-up wait across all denying cooldown/GCRA policies and sorted
internal policy IDs, without changing any state or audit timestamp. Thus an
admission at 00:00 followed by a check at 00:06 reports 54 seconds remaining.

On allowance, both GCRA policies receive one charge and every retained cooldown
alias receives count=1 and boundary=operationNow plus its configured interval.
All changes share the savepoint and outer transaction: a later write failure
cannot leave partial cooldowns or charges even if the owner catches the error.
The result remains provisional until outer commit. The owner must configure
bounded timeouts, retry only confirmed aborts by rerunning the entire outer
transaction, and handle uncertain commit outcomes under the existing contract.
It must compose these changes with actual Delivery creation before production
use. Denial must not commit a replacement challenge created by the owner.

The precision migration widens `AuthenticationRateLimit.windowEndAt` from
TIMESTAMP(3) to TIMESTAMP(6), preserving existing values and the timestamp-without-
time-zone UTC convention. SQL reads and writes exact integer microseconds;
security boundaries never pass through JavaScript Date or floating-point epoch
seconds. No challenge field is added. This operation does not lock, consume,
extend or mutate the challenge, proof, attempt count or Delivery rows.

Unit tests cover exact boundary eligibility and one microsecond on either side,
combined denial, invalid state and rollback. Real PostgreSQL tests cover
cross-client same-identity concurrency with different challenges/IPs, retained
aliases and configuration changes, denial immutability, submillisecond and
session-timezone round trips, fresh time after row waits, outer/savepoint
rollback, injected confirmed-abort whole-owner retries, and unchanged real
challenge/encrypted-proof records. These complete the Iteration 3 mechanism
scope; domain enforcement and gated OTP-lock removal remain later work.

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

#### Iteration 2 configuration boundary and rollout

The configuration-only implementation snapshots six auth-domain GCRA policies
and two Delivery cooldown intervals in `AuthenticationRateLimitConfigService`.
`HttpRequestRateLimitConfigService`, outside Auth, separately snapshots the
public passwordless request group. This group covers only the four POST routes
listed under the accepted public request policy; it does not select routes or
enforce requests yet. All settings are required, validated positive safe
integers, with public V1 examples in `.env.example`. GCRA retains the exact
`burst`, `rate`, and `periodSeconds` inputs; no rounded interval is configured.
There are no additional timed verification penalties, global capacity defaults,
or provider-gate settings in this boundary.

Values are captured at application startup, not reloaded during a request.
Deploy the same complete settings to all replicas serving one protection scope.
Once enforcement is enabled, do not roll out changed parameters while old and
new replicas simultaneously admit operations. Drain protected admissions and
in-flight transactions, apply the coordinated configuration/state transition,
then resume with matching settings on every replica. Ordinary code rollout with
unchanged policy settings does not require such a policy transition.

Configuration values and deployment/configuration versions must never become
part of bucket identity or trigger state deletion. Preserve existing cooldown
`windowEndAt` boundaries; a new interval applies only to a subsequent successful
admission. GCRA tuning must preserve outstanding debt, without a fresh burst,
and must not reset independent policy state or shorten waiting merely by
restarting a replica. Exact storage and conservative active-TAT conversion are
defined and tested in “Exact GCRA state persistence and arithmetic” above.
Their locked, atomic application across retained aliases remains an Iteration 3
database/concurrency gate before enforcement or tuning is enabled. Until that
gate is met, changed parameters cannot be applied to active enforced GCRA state.
Denial still follows persisted state and fresh DB time without an extra reset
or penalty timer.

This patch prepares validated configuration only. Startup validation and unit
tests do not establish replica agreement, migrate debt, implement rate limiting,
or retire the legacy OTP lock. HTTP integration and effective-configuration
telemetry remain their owning later work.

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
for a replacement challenge after expiry, once any remaining identity
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
The email and IP policies below fix Delivery burst/rate parameters for this
scenario; aggregate/global/provider contracts are fixed below, with numerical
global capacity selection deferred to measurements. Account
separately for legitimate shared-IP usage and email-bombing exposure.

All Delivery admissions remain subject to challenge lifecycle, cooldown,
Delivery budgets, global admission, and provider restrictions. Verification-only
mitigation does not itself deny Delivery admission.
The requirement does not reserve quota for a client, bypass exhausted/shared
budgets, reset identity/IP accounting on a new challenge, or guarantee physical
email delivery. Resends keep the same proof and do not reset OTP attempts;
replacement challenges receive new proof and must not bypass cross-challenge
verification protection.

### Accepted email Delivery budget — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 values, not implemented.

| Scope | Full burst capacity | Sustained replenishment rate |
| --- | --- | --- |
| Normalized institutional email | 10 admitted Deliveries | 7 per 3600 seconds (one allowance per 3600/7 seconds, approximately 8 minutes 34.286 seconds) |

All initial Deliveries, explicit Resends, and initial Deliveries of replacement
challenges for that email share this bucket across challenges, IPs, clients,
and purposes. Each successfully committed new Delivery admission charges one
unit. Repeated initial resolution without a Delivery, cooldown/window/other
admission denial, and rolled-back creation do not charge. Provider failure after
admission does not refund; retries of the same Delivery do not charge this
bucket again. Provider submission accounting stays separate.

Keep an independent opaque email Delivery TAT, distinct from verification TAT
and the identity/challenge cooldown state. Preserve the shared GCRA exact burst
convention and authoritative DB time; use interval 3600/7 seconds without rounding
it on each charge. Eligibility is computed atomically with all applicable
Delivery policy checks. Email GCRA charge, other applicable Delivery charges,
cooldown establishment and Delivery creation
commit or roll back together. No provider I/O occurs inside admission. Denial
never supersedes existing work or changes proof/TTL. Key rotation, configuration
rollout, and cleanup must not erase outstanding debt.

The separate identity/challenge minimum interval remains 60 seconds. Passing
GCRA does not bypass it, the delivery-validity window, IP/global admission, or
provider restrictions. Email capacity exhaustion denies new Delivery admission,
not verification of an existing live proof. New challenges do not reset debt.
There is no fixed-hour reset, additional timed penalty, or full-reset timer.
These values do not mean at most seven or ten Deliveries in every hour.

Nominal example, using minutes:seconds elapsed from first admission, initially
idle budgets, exact timestamps, and no unrelated usage/other denials:

```text
00:00               initial Delivery #1
01:00 through 08:00  eight Resends, Deliveries #2 through #9
10:00               replacement after expiry, initial Delivery #10
11:00               Resend, Delivery #11 (email GCRA permits it)
12:00               email GCRA denies; about 5 minutes 8.571 seconds remain
17:08.571...        next email allowance, Delivery #12 if all other checks allow
25:42.857...        next email allowance after that charge
```

Public wait seconds round upward; internal TAT retains precision. The original
replacement challenge is expired by the last time shown, so email eligibility
alone does not authorize Resend of it. A different eligible/new challenge flow
would be needed. Denied attempts do not move these eligibility boundaries.

From fully idle state, the GCRA envelope permits up to sixteen admissions in
[0, 3600) seconds if other policies/lifecycle permit, then sustained usage tends
to seven/hour. That email-bombing allowance is the accepted initial trade-off
for gradual recovery and the ten-Delivery UX reserve, not proof of sender
legitimacy or guaranteed physical message volume. Apply independent IP/request/
global/provider protections and operational analytics; revisit these configurable
values with legitimate recovery and abuse data. Exact combined HTTP error
precedence/response mapping remains Stage 5 work.

### Accepted IP Delivery budget — GCRA

Status: **ACCEPTED / FIXED** as initial configurable V1 values, not implemented.

| Scope | Full burst capacity | Sustained replenishment rate |
| --- | --- | --- |
| Canonical source IP | 120 admitted Deliveries | 240 per 3600 seconds (one allowance per 15 seconds) |

Aggregate initial, Resend, and replacement initial Delivery admissions across
all normalized emails/challenges/clients using that source IP. Every committed
new Delivery charges one unit in both the email and IP Delivery buckets; both
must allow admission. If either or another required policy denies, do not create
or supersede a Delivery or partially charge either bucket. Charge/cooldown/
creation must compose in one atomic transaction. Resolution without
a Delivery, denied requests, and rollback do not charge; later provider failure
does not refund and processing retries of the same Delivery do not charge again.

Maintain independent opaque IP Delivery TAT, separate from email Delivery,
verification, and cooldown state. Identity/challenge changes do not reset this
IP's debt. Rate recovery requires no timed penalty or periodic full reset. Use
fresh DB time, exact GCRA burst semantics, atomic concurrency, safe cleanup/key
rotation/config rollout, and shared analytics requirements. Denial prevents new
Delivery admission, not existing-proof verification by itself. Combined denial
precedence and public mapping remain owning Stage 4/5 work.

The burst is a shared-network capacity assumption, not proof that a source is
legitimate or a guarantee for every campus. With idle budgets and no other
blockers, fifty simultaneous initial admissions leave seventy allowances;
after sixty seconds four more have recovered, allowing fifty Resends. Success
at proof verification does not itself consume Delivery capacity, but each
initial letter does. A source requesting different emails can also spend the
same initial burst: preserve independent email, request, global, and provider
protection. This is not a strict 120/hour or 240/hour quota; tune the initial
parameters using legitimate shared-IP usage and abuse analytics.

### Accepted public passwordless request policy

Status: **ACCEPTED / FIXED** as configurable V1 starting semantics/values;
enforcement and production capacity validation are not implemented. Use one
GCRA request bucket per canonical source IP for the following route group:

```text
POST /auth/challenges
POST /auth/challenges/:challengeId/resend
POST /auth/challenges/:challengeId/verify-otp
POST /auth/challenges/:challengeId/verify-link
```

| Scope | Full burst capacity | Sustained replenishment rate |
| --- | --- | --- |
| Public passwordless group / canonical source IP | 200 unit requests | 600 per 60 seconds (10 per second, one allowance per 100 milliseconds) |

These are burst-plus-rate settings, not a strict maximum of 600 requests in
any minute or a measured throughput guarantee. The same bucket is shared by
all clients behind one public IP. There is no extra timed block or periodic
reset. From idle state, nominal single-IP arithmetic admits fifty initial
requests and fifty verify requests thirty seconds later. With 200 requests at
zero and another 200 at ten seconds, the first wave passes and only 100 of the
second wave pass this limiter. Domain Delivery/verification policies may deny
operations even when the HTTP request passed.

All four operations share the same group bucket for that IP, independent of
identity, challenge selector, or endpoint. Cost is one for each request admitted
by this policy. Atomically check capacity and commit its request TAT update
before JSON parsing, DTO validation, and domain-service execution. Later success, validation
failure, unknown/terminal challenge, cooldown/verification/Delivery denial, or
downstream technical failure does not refund the admitted request. Do not put
request charging inside a later domain transaction that could undo it.

If request GCRA denies, do not advance its TAT, extend waiting, or execute the
domain operation; return RATE_LIMIT_EXCEEDED (429) with one authoritative
retryAfterSeconds in body/header. Authoritative limiter infrastructure failure
fails closed as technical unavailability, not fabricated policy denial. Request
state is independent of Delivery/verification accounting; no weighted costs or
identity request bucket is selected by this decision.

ACCEPTED / FIXED V1 HTTP boundary: enforce the selected route-group policy
before JSON parsing, DTO validation, and domain logic. An admitted request with
malformed JSON retains its unit request charge but does not charge verification
failure or Delivery budgets and does not mutate challenge state. A request-policy
denial does not invoke the JSON parser or domain operation; infrastructure
unavailability also fails closed before those stages. A guard running after the
body parser is insufficient for this coverage; concrete bootstrap/middleware
composition belongs to Stage 5–6 integration. Do not parse the body merely to
select this route-group policy.

Do not add a separate malformed-JSON limiter in V1. Collect privacy-safe parser
error metrics without recording request bodies or proof. The common IP bucket
accepts the risk of shared-IP starvation: malformed or valid traffic from one
client can consume capacity needed by others, and denied requests do not extend
TAT but a continuing admitted stream can keep spending recovered capacity.
Validate campus/shared-network behavior in load tests and pilot analytics.
This is application protection, not a replacement for edge DDoS controls; the
limiter's own database work needs load testing.

Implement the request mechanism as reusable infrastructure outside Auth, with
explicit route-group policy, canonical characteristics, configuration, GCRA
results/retry-after, and telemetry. Auth is its first consumer. Do not
implicitly put Profile, future Clubs/Events, refresh, protected sessions,
STEP_UP-specific routes, GET fallback, or all APIs into this shared auth bucket.
Other groups can reuse the mechanism with their own future policies. Keep V1
unit cost; no generic weighted-cost framework is required.

Use the accepted source-resolution/canonicalization contract below. Deployment
values for proxy trust/header selection, concrete pre-parser integration, and
detailed technical error mapping remain owning Stage 4 and Stage 5–6 work. Configuration/rotation/cleanup must preserve applicable request TAT, and
analytics must identify this policy separately from domain denials.

Validate these initial settings with concurrency and load tests, including
single-IP hot-bucket contention, mixed endpoints, many IPs, denied-request DB
cost, and p95/p99 latency/errors. Load tests establish technical capacity and
correct enforcement, not real human error rates or campus concurrency. Use a
pilot and privacy-safe production metrics to tune shared-IP denials, completion,
and abuse exposure. A client behind a shared IP can consume others' allowance;
this limiter does not guarantee fairness or replace edge DDoS protection.

### Accepted source IP resolution and canonicalization contract

Status: **ACCEPTED / FIXED target; no runtime change in this decision.** Keep
source resolution separate from canonicalization in reusable HTTP/security
infrastructure outside auth-specific policy logic and independent of the hosting
platform.

Source resolution selects one source IP at the HTTP boundary according to an
explicit deployment trusted-proxy contract. Express request.ip is the default
mechanism; it is not permission to trust arbitrary forwarded headers. If a
hosting platform requires another authoritative header mechanism, use an explicit
boundary integration under its validated trust contract. Never guess by trying
multiple arbitrary headers. The canonicalizer must not interpret forwarding
chains or choose which source is trusted.

The canonicalizer accepts exactly one IP literal, strictly validates it using
the existing ipaddr.js dependency, and produces one deterministic representation.
Do not use handwritten regex normalization or guess addresses from lists,
IP-with-port strings, or arbitrary transport syntax. Library acceptance alone
must not silently expand this strict input contract; concrete parser options
and checks require focused tests. Convert IPv4-mapped IPv6 to IPv4, normalize
IPv6 consistently, and retain private/loopback addresses. Do not reuse the GeoIP
public-address filter, which intentionally discards those addresses.

Resolve/canonicalize once per HTTP request before the protected parser/domain
paths and share that canonical IP with all applicable IP-based security policies.
Request, Delivery, and verification budgets remain independent; a common source
characteristic does not merge counters. Missing/untrustworthy source resolution
or failed canonicalization fails closed for protected auth endpoints. Do not
continue without applicable IP protection or manufacture an attacker-selectable
fallback bucket. This is technical source-resolution failure, not quota denial;
its exact public mapping remains open.

IPv6 prefix-based limiting is deferred until demonstrated need. Literal
canonicalization does not prevent address rotation within an IPv6 allocation.
Use the accepted deployment proxy trust boundary below. Concrete proxy
addresses/ranges and the selected header mechanism remain deployment values to
choose and verify before staging; current proxy-trust configuration is unchanged.

### Accepted deployment proxy trust boundary

Status: **ACCEPTED / FIXED target; not implemented.** Source resolution follows
explicit deployment configuration, never the mere presence of HTTP headers.
V1 distinguishes direct and proxy-only deployments; no implicit mixed mode or
arbitrary-header detection is introduced.

- Direct mode uses socket peer IP and ignores all forwarding headers.
- Proxy-only mode first verifies that the immediate socket peer is trusted under
  the deployment contract. Reject untrusted peers on protected auth endpoints;
  do not fall back to treating the proxy address as the client address.
- For a forwarding chain such as X-Forwarded-For, resolve from the socket peer
  through trusted hops, scanning the header right to left until the first
  untrusted address. Do not blindly select the first/leftmost value.
- For a single-IP mechanism such as X-Real-IP or CF-Connecting-IP, the chosen
  ingress must authoritatively set the value and sanitize client-supplied input.
  Trust in the immediate peer alone does not prove that it sanitized a header.
- Use only the selected mechanism. A missing required source, malformed value,
  or untrustworthy resolution fails closed without switching to another header
  or socket IP. Unknown proxies never gain forwarding-header authority.

Canonicalization remains independent and accepts only the single IP literal
produced by source resolution. No change to policy budgets or canonicalization
semantics is introduced. Source-resolution failures are distinct from quota
denials; exact public error mapping remains owning Stage 5–6 work.

Production startup must reject missing or contradictory required proxy-trust
configuration; it must not silently enable blanket trust or an implicit mode.
Startup checks configuration validity, not the actual network's correctness.
Before staging, choose exact trusted proxy addresses/ranges and the supported
header mechanism for the hosting platform, and verify real ingress topology,
header sanitization, chain traversal, and protection against origin bypass.
Deployment tests must include spoofed headers, untrusted direct access, missing
or malformed required sources, and supported multi-proxy paths. Preserve these
checks when changing hosting or adding an edge proxy. This decision does not
configure Render/Railway/VPS ranges, enable Express trust proxy, or change runtime.

### Accepted auth Delivery backlog accounting

Status: **ACCEPTED / FIXED** accounting model; internal backlog enforcement is
implemented in Stage 4 Iteration 6 block 1. Production backlog sizing and the
global admission rate remain open. Internal denial semantics
are fixed below; HTTP mappings and UX remain Stage 5–6 work. A global admission rate bounds incoming new Deliveries; a backlog
limit bounds outstanding work. Neither replaces the other or the provider gate.

One backlog unit is one admitted AuthenticationChallengeDelivery whose processing
has not completed. Count PENDING (including delayed retries and capacity waits)
and PROCESSING across all replicas. SENT, FAILED, and CANCELLED do not occupy
backlog capacity. SENT means provider acceptance, not guaranteed mailbox arrival.
A retry continues the same Delivery and does not allocate another backlog unit.
This is one aggregate auth Delivery backlog, not per-identity queues or a backlog
limit for all notification emails.

Admission reserves a free backlog unit in the same atomic transaction as
applicable quota/cooldown mutations and Delivery creation. Normal V1 resend does
not replace unfinished work: resolving PENDING/PROCESSING requires no additional
backlog unit and remains possible at full backlog. Any new outstanding Delivery
requires free capacity. Concurrent replicas must not exceed the configured limit;
an uncoordinated count followed by insert is insufficient. Concrete persistence
and locking belong to Iteration 6 and compose with Iteration 4 transactions.

The one-unfinished-Delivery-per-challenge invariant also holds under concurrent
Resend requests. Repeated requests preserve worker leases and retry schedules.
Backlog capacity does not bound external calls still in flight after lifecycle
changes. Lease expiry alone does not release capacity: recoverable PROCESSING
work counts. Delivery-window closure must lead to timely terminalization;
cleanup and recovery must progress even at full backlog. Temporary provider gate
exhaustion alone does not prohibit accepting new PENDING work when admission and
backlog permit it.

If initial admission is denied, do not commit a newly created challenge without
its initial Delivery or preserve partial admission charges. Failure to admit a
next Delivery does not invalidate an existing challenge: an earlier email may
already have arrived or still be in flight, and proof verification retains its
own lifecycle. Preserve Stage 3 validity checks after any capacity wait before
submission; backlog size and nominal send rate alone cannot guarantee delivery
time.

Iteration 6 block 1 implementation: AuthenticationDeliveryBacklogRepository
updates the seeded singleton AuthenticationDeliveryBacklogState row (id=1),
then uses a separate statement to count actual PENDING/PROCESSING rows and sample
fresh DB microsecond time. There is no stored backlog count to repair or refund.
All application new-Delivery paths enter through AuthenticationDeliveryAdmissionService;
the lower repository creation methods remain persistence-only owner primitives.
The coordination lock lasts through policy checks, insertion and owner commit.
Updating the row, rather than only acquiring an advisory/row lock, forces an old
Serializable snapshot to abort after a preceding ReadCommitted or Serializable
admission. The owner retries confirmed aborts only in a new whole transaction.
ReadCommitted remains the operation owner's default isolation.

The order is operation/subject/challenge and unfinished Delivery locks, backlog
coordination row, then the existing complete rate/cooldown advisory union and row
order. Shared window logic checks fresh time after backlog waiting and again
after bucket waiting. Missing coordination state is technical fail-closed, never
capacity denial and never silently recreated. Reuse/EXISTING resolution enters
neither the backlog row nor new-Delivery rate checks. Every business denial rolls
back its coordination-row touch and partial admission work; a new INITIAL's
challenge/subject is also rolled back by the request owner. Durable operation
receipts record/replay capacity denial with null retry boundary and wait. An old
denial remains historical when a slot later opens; a new operation can re-evaluate.

Terminal status changes, retry scheduling, expired-lease recovery and retention
cleanup do not need the coordination row: they never add outstanding work, and
thus may release capacity or make progress while backlog is full. This bounds
committed unfinished auth Delivery rows, not provider calls still in flight.
The required AUTH_DELIVERY_BACKLOG_LIMIT is a positive safe integer; experimental
1000 in .env.example/test defaults is not a production capacity recommendation.
The additive migration creates/seeds only the coordinator and extends
AuthenticationOperationDenial; existing challenge, Delivery, rate and receipt
records are preserved. Regenerate Prisma and configure the setting on rollout.
All new-Delivery admission writers must run this protocol before claiming strict
cross-replica enforcement; old admission writers bypass the coordinator. Existing
backlog above a newly configured limit is retained and drained normally; new work
is denied until the outstanding count falls below the limit.

Unit tests and test/authentication-delivery-backlog.e2e-spec.ts use real database
services (only external email submission is replaced), with an explicit test
limit of 3. They verify last-slot concurrency, both supported isolation levels,
stale Serializable aborts, count semantics, release/recovery, rollback, missing
state, expiry/window during waits, immutable full-capacity denial, stable proof,
receipt replay/reconciliation and independently committed request accounting.
These are internal correctness checks, not production capacity measurements.
Existing bucket-wait scenarios start with an open positive one-second test
window, then cross window/expiry during the real wait; a challenge already below
the production window is now correctly rejected at the earlier backlog checkpoint.

### Accepted Global Delivery Admission outcomes and commit uncertainty

Iteration 6 block 2 adds the global creation budget to
AuthenticationDeliveryRateLimitService's fixed plan alongside identity/IP and
both cooldowns. It shares the full advisory-lock union, existing row lock order,
fresh microsecond timestamp, exact GCRA arithmetic and savepoint. Successful new
INITIAL/RESEND charges each applicable policy once in the same transaction as
Delivery insertion. Any denial/failure leaves no partial global/personal charge,
cooldown movement or coordinator touch. Reuse, unfinished-work resolution and
provider retries do not enter new-Delivery admission and do not spend this budget.

Global state is one existing GcraRateLimit row at the fixed technical key
gcra:auth:delivery-admission:v1 with policyId AUTH_DELIVERY_GLOBAL. It contains no
user characteristic and has no HMAC aliases. The v1 HMAC derivation protocol is
unchanged; rotation of user-characteristic keys does not select a fresh global
bucket. The DB key CHECK permits exactly this fixed key/policy pair in addition
to the original HMAC-key form; arbitrary system keys are not admitted. Active
global state must obey the same exact persistence, explicit-retuning and safe
retention rules as other GCRA state. Lifecycle replacement, Delivery terminalization
and challenge retention cleanup do not refund it.

Required AUTH_DELIVERY_GLOBAL_BURST, AUTH_DELIVERY_GLOBAL_RATE and
AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS are validated positive safe integers and
captured in a frozen config snapshot. Example 100 burst / 120 per 60 seconds is
experimental, independent of backlog 1000 and provider permission spacing. It is
not a strict fixed-window quota or a production capacity recommendation. Test
defaults are larger to isolate unrelated suites; focused tests explicitly use
burst/rate 3 and reset only the fixed global key in the dedicated test DB.

If global state denies, internal admission returns GLOBAL_RATE_DENIED; otherwise
personal/cooldown denial remains RATE_LIMITED. Both report all denying policy IDs
and the latest joint absolute eligibility boundary, with positive waits rounded
up only at reporting. No extra penalty or full-period reset is applied. Operation
receipts persist this boundary rather than resetting a duration on replay; a
historical denial never turns into new admission when its remaining wait reaches
zero. Key/policy binding and rate-outcome attribution are also DB constrained.
An enum migration is committed before the following receipt CHECK migration;
a third additive migration narrows the key exception. No old data is rewritten
and Prisma is regenerated. Configure all three new settings on rollout.

Unit and test/authentication-global-delivery-admission.e2e-spec.ts exercise real
crypto, services, receipts, worker and PostgreSQL; only external email submission
is replaced. They cover shared capacity across clients/identities/IPs, mixed
denial precedence/max-wait, global immutability on personal denial, partial-write
rollback, actual persisted-boundary recovery, expiry/window during global bucket
waits, retry/reuse bypass, retention and DB constraints. Historical cooldown/global
state fixtures are explicit and do not claim production throughput. Provider
permissions, pressure/Retry-After and durable notification deferral remain later
blocks; no provider gate is introduced by this creation budget.

Status: **ACCEPTED / FIXED; internal capacity/global-rate admission and durable
receipt handling implemented in Iteration 6 blocks 1–2.** Distinguish these internal
outcomes without conflating policy decisions and availability failures:

| Internal outcome | Meaning | Retry information |
| --- | --- | --- |
| GLOBAL_RATE_DENIED | Persisted global creation-rate state denies new admission | One authoritative retryAfter derived from persisted state and DB-authoritative time |
| DELIVERY_CAPACITY_UNAVAILABLE | No free auth Delivery backlog capacity | Exact release time is unknown; do not manufacture an authoritative quota retryAfter |
| INFRASTRUCTURE_FAILURE | Required admission state cannot be read, evaluated, or durably established | Technical failure, never disguised as ordinary policy denial |

A reliably established denial does not admit new work. Preserve atomicity of
all admission mutations: no partial Delivery/global quota charges, cooldown,
challenge changes, or Delivery changes. Confirmed rollback leaves those mutations
absent. Existing committed request-level accounting is separate and is not
refunded. Initial denial must not leave a new challenge without initial Delivery;
existing proof and unfinished work retain their lifecycle. Resolving an existing
unfinished Delivery is not new admission and does not consume global creation
capacity or another backlog slot, although normal request/lifecycle/ownership
checks and authoritative access to existing state are still required.

A connection loss while committing is not evidence of rollback. Distinguish
known committed, confirmed not committed, and unresolved commit outcomes. On an
unresolved outcome, do not assert that no Delivery/charges/cooldown exist and do
not blindly repeat admission as a fresh operation. Reconcile against durable
operation identity/state or use an equivalent safe idempotent retry mechanism
that cannot create a duplicate admission or charge any admission budget twice.
Stage 3 provider idempotency alone is insufficient: it protects submission of
one Delivery, not creation of two Delivery records. The one-unfinished-Delivery
invariant is necessary but alone does not identify an earlier operation after
its Delivery becomes terminal. No compensating refund or challenge invalidation
is justified merely by lost commit acknowledgment.

Iterations 4/6 design transaction-composable admission and durable reconciliation/
idempotent retry; Iteration 7 tests connection loss around commit, reconciliation,
concurrent retries, and a previously committed Delivery becoming terminal before
retry. Do not introduce a new public idempotency field or schema in this decision.
HTTP mappings and user retry UX are Stage 5–6 work. A rate retryAfter describes
recovery of the applicable rate budget, not a guarantee that backlog or all other
conditions will allow a future request.

### Accepted measurement-first global capacity selection

Status: **ACCEPTED / FIXED** measurement plan; no load tests have been executed
as part of this documentation decision. Numerical global admission rate/burst
and backlog limit remain explicitly open until measurements. Preserve the seven
Stage 4 iterations: implement the required mechanisms before measuring them,
and select preliminary production thresholds before rollout.

The ambitious normal-load objective is p99 below one second from backend receipt
of an initial/resend request that creates a Delivery to provider acceptance.
Measure mailbox arrival separately; provider acceptance does not guarantee inbox
delivery time. Define and report the tested normal-load envelope rather than
claiming this objective for arbitrary bursts. Report admission denials and
failures separately so fast rejection or excluded failed work cannot make the
latency objective appear satisfied.

Use real PostgreSQL, real admission/worker/gate paths, and a controllable fake
provider to measure sustainable throughput and latency under progressively
increasing offered load on one and multiple replicas. Maintain the offered
arrival rate independently of slow responses; do not hide overload by making
the generator wait for each completion. Sustainable throughput means outstanding
work does not grow over a sustained run, not merely a short peak send rate.

Test simultaneous bursts of 10, 50, 100, and 500 requests creating distinct
Deliveries, using distinct eligible identities/IPs to isolate global protection.
Also test concurrent initial/resend requests for one challenge and verify at
most one unfinished Delivery. At an otherwise idle eight/second gate the last
permission in these bursts cannot arrive sooner than (N - 1) / 8 seconds:
1.125, 6.125, 12.375, and 62.375 seconds respectively, excluding provider latency
and competing email traffic. These are ideal permission-spacing bounds, not
predictions or a promise of subsecond burst completion.

Exercise slow provider calls, transient failures, ambiguous timeouts, Retry-After,
full outage, and recovery, with competing notification emails and retries using
the shared gate. Verify retained work, bounded backlog, no retry storm, preserved
provider restrictions, and continued recovery/cleanup under saturation. Use
explicitly experimental backlog/rate settings to check exact limits and atomic
rollback under concurrency; these test inputs are not approved V1 thresholds.

Record HTTP/admission latency, worker wait, provider gate wait, provider-call
latency, and end-to-end time to acceptance, including p95/p99. Record outstanding
work and its oldest age, accepted/denied rates, provider attempts, retries,
failures, closed delivery windows, and post-outage drain time. Keep telemetry
privacy-safe and report test conditions, sample sizes, duration, replica/worker
configuration, and provider behavior with results.

Run only a bounded, separately authorized real-Resend validation for actual
provider latency and mailbox arrival, accounting for team sending quotas; do not
use real recipients for bulk fault/load tests. Compare measured sustainable auth
throughput, competing send demand, and acceptable user wait to choose preliminary
global rate/burst and backlog settings with headroom. Backlog approximately equals
throughput times waiting time only as a planning estimate, not a deadline
guarantee. The 600-second proof lifetime and 120-second submission-validity
minimum do not make 480 seconds an acceptable UX wait. The acceptable waiting
budget and expected launch traffic remain product inputs to refine. Validate
preliminary settings against pilot traffic before treating them as established
human-use thresholds.

Iteration 7 block 1 supplies a bounded local stand using these real internal
services and a loopback HTTP provider. Its report includes arrival scheduling,
operation/HTTP/response-emission latency and sampled backlog; individual worker
and gate waits remain later instrumentation work. Block 2.1 extends this with
two independent OS processes, concurrent INITIAL/RESEND resolution and observed
committed shared-gate grants, with receipt-based admission accounting. These are
small internal correctness checks, not production capacity results.
The first step of block 2.2 verifies personal cooldown denial attribution and
independent-identity admission under repeated INITIAL/RESEND traffic. It preserves
active debt and absolute cooldown boundaries; it does not exercise personal GCRA
exhaustion, shared-IP saturation or establish latency isolation under heavy load.
See [the load stand guide](auth-iteration-7-load-stand.md) for
the exact boundary, retained-state behavior, command and remaining blocks.

### Accepted shared Resend send gate and mail integration boundary

Status: **ACCEPTED / FIXED** as configurable V1 starting values. The internal
permission core is implemented in Iteration 6 block 3.1; shared provider pressure
and the common transport are implemented in block 3.2. Auth worker integration
is implemented in block 4; block 5 routes all remaining application senders
through the shared transport with durable notification deferral. Block 6 completes
internal integration checks; the scenario matrix and evidence are recorded in
[Iteration 6 verification](auth-iteration-6-verification.md). Load/fault metrics,
production capacity selection and broader hardening remain Iteration 7 work.
The operator confirmed the current Resend team API ceiling is 10 requests per
second. This applies to the team across keys and replicas, not each worker.
Resend documents the team scope and rate-limit/Retry-After headers in
[Usage Limits](https://resend.com/docs/api-reference/rate-limit).

All application email sends through the same Resend team share one gate of eight
submission permissions per second across all replicas, with no accumulated
burst: minimum 125 milliseconds between granted permissions. A GCRA capacity
of one with sustained rate eight per second expresses the intended spacing.
Idle time does not accumulate a batch of eight immediate permissions. Preserve
subsecond authoritative-time precision. This includes passwordless initial and
resend emails, suspicious-activity and account-deletion emails, all provider
retries, and future email scenarios. Existing legacy sends must also use the
gate while those paths remain. There are no per-scenario reserved allocations
or priority queues in this V1 decision. Retries do not re-charge email/IP
Delivery budgets; notification sends do not acquire auth Delivery quotas merely
because they share provider capacity.

A small shared mail-infrastructure boundary outside AuthModule must make the
gate mandatory for application Resend sends. Callers supply the recipient,
content/template data, and a stable idempotency key; they must not implement
separate provider limiters or call Resend directly. New email scenarios reuse
this boundary without gaining another eight/second allowance. Scenario-specific
admission and anti-bombing policies remain separate from the provider gate.

Reliable deferred sending must preserve pending work when capacity is not yet
available. Keep the existing Stage 3 Delivery lifecycle, leases, retry ownership,
and provider idempotency: do not enqueue the same auth email into a second
independent retry system. Notification sends need reliable deferral instead of
losing a direct-send request on capacity denial. Concrete interfaces and
persistence/claim/defer composition belong to Stage 4 Iteration 6; this decision
does not introduce a universal notification framework or a new chat system.

The nominal two-requests/second difference is headroom, not a separately
reserved or guaranteed quota. Administrative/API reads or other applications in
the same Resend team can consume it. Audit and route all application send paths
through the gate before claiming application-wide enforcement; external team
clients remain outside that guarantee. Additional keys or replicas do not create
extra capacity. The current team ceiling is deployment/provider data, not a
permanent protocol constant; confirm on provider configuration changes.

Keep applicable provider Retry-After and cross-Delivery restrictions authoritative;
passing the eight/second policy never shortens those waits. Local capacity
waiting must not appear as a provider failure or consume processing attempts.
Do not hold database locks during provider I/O. Permission/crash accounting,
concrete claim/defer implementation, team email quota exhaustion, and aggregate
admission remain open design work. A granted permission is not proof that the
provider received a network request.

Iteration 6 block 3.1 implements MailSubmissionGateService.tryAcquire in
MailModule using the existing GcraAdmissionRepository, assessment/arithmetic and
transaction bounds. It owns an independent ReadCommitted transaction, locks the
fixed key, locks/reads the row, samples fresh DB microseconds and either writes
one permission or returns an immutable deferral. The result is released only
after commit, when DB locks are no longer held. Burst=1 and period=1 second are
fixed in a frozen MailSubmissionGateConfigService policy snapshot. Required
MAIL_RESEND_SUBMISSIONS_PER_SECOND (example 8) is a positive safe integer no
larger than MAIL_RESEND_TEAM_REQUESTS_PER_SECOND (example 10). The ceiling is
operator/provider configuration, not a permanent protocol assertion or a live
provider lookup. Active snapshot changes require explicit retuning; the gate
never silently resets incompatible persisted state.

The system key gcra:mail:resend-submission:v1 is bound exclusively to policyId
MAIL_RESEND_SUBMISSION. An additive CHECK migration permits only this additional
system pair while preserving the existing fixed auth-creation pair and v1 HMAC
keys. It adds no table/Prisma-model changes and rewrites no rows. State stores only
permission time and policy settings, never recipient, content, proof or provider
idempotency keys. It is independent of auth creation/backlog/verification budgets.

GRANTED carries operationNowMicros and nextPermissionNotBeforeMicros; DEFERRED
carries operationNowMicros and retryNotBeforeMicros. Absolute boundaries ceil
fractional microseconds rather than rounding waits to seconds. Deferral writes
nothing, reserves no future slot and is not a provider failure. No external I/O,
wait-until-eligibility loop, scheduler, refund, payload handling or send retry is
part of this core. A committed but unused permission stays spent, including a
caller stopping before submission. Only confirmed SQL transaction aborts permit
bounded whole-owner retries. After an unconfirmed commit failure the caller gets
COMMIT_OUTCOME_UNKNOWN, not a grant or blind retry. Technical state failures fail
closed and remain distinct from capacity deferral.

Unit checks cover exact microsecond eligibility, frozen/no-burst configuration,
transaction bounds, sanitization, retry exhaustion and commit-uncertainty handling.
Fifteen real PostgreSQL checks use two independent clients and actual SQL fault
injection for spacing, idle recovery, fresh time after advisory/row waits, lock
timeout, incompatible state, immutable deferral, unused permissions, fractional
intervals, confirmed-abort retry and exact key binding. Concurrent tests use actual
DB decision times and allow genuine replenishment during execution; they do not
assume a frozen clock or establish production throughput. Actual transport fault
and commit-acknowledgement loss testing retains its later integration owner.

At the end of block 3.1 the core was exported but no existing sender invoked it.
Application-wide enforcement remains pending until every sender is migrated. Block 3.2 adds the pressure-aware common
transport described below; auth claim/defer belongs to block 4, other send paths/
reliable notification deferral to block 5, and final integration to block 6.
No existing retry/lifecycle ownership is changed in blocks 3.1–3.2.

#### Shared provider pressure and common transport — block 3.2

MailProviderPressure is a migration-seeded singleton for the configured Resend
team, independent of Delivery retention. It stores only absolute microsecond
rate/daily boundaries, a monthly block and a monotonic revision. It contains no
recipient, payload, proof or idempotency key. Missing state fails closed; runtime
code never recreates/reset it. The additive migration changes no existing rows;
the Prisma client is regenerated.

MailProviderPressureService.observe and MailSubmissionGateService.tryAcquire use
the same fixed mail gate advisory lock, then the pressure row lock. Acquisition
also locks/reads the GCRA row before sampling fresh PostgreSQL clock time. The
strongest active timed boundary wins; monthly exhaustion returns PAUSED with
reason MONTHLY_QUOTA and no invented retry time. Both PAUSED and DEFERRED leave
GCRA and pressure state unchanged. HTTP runs after the permission transaction
commits, with no DB locks held. Permissions ordered before a new pressure
observation cannot be retracted and may already be in flight; this is no
distributed in-flight semaphore or guarantee about network arrival spacing.

Quota names are classified before generic HTTP 429. daily_quota_exceeded pauses
until the next UTC calendar midnight based on DB observation time; a later
Retry-After still wins. Resend documents this daily reset in
[Usage Limits](https://resend.com/docs/api-reference/rate-limit).
monthly_quota_exceeded persists a block without guessing a billing reset date.
After verifying recovery with the provider, an operator may explicitly invoke
MailProviderPressureService.clearMonthlyBlock(expectedRevision). It returns false
for stale revisions and never clears independent timed restrictions. No public
recovery endpoint, automatic quota probe, plan quota count or calendar-month reset
is introduced.

Retry-After is shared across messages/keys/replicas, including responses other
than 429. Numeric seconds are measured from fresh DB observation time after
lock waits; strict HTTP dates remain exact absolute boundaries. Existing later
boundaries are never shortened. Oversized numeric waits saturate at signed
64-bit microseconds, an effectively indefinite fail-closed pause. A rate-limit
response without a valid header uses required positive integer configuration
MAIL_RESEND_RATE_LIMIT_FALLBACK_SECONDS (example 1). A valid zero/past header does
not invoke that fallback; the normal GCRA gate still applies. Daily/monthly
errors use their quota rules instead of the short fallback. This does not
proactively count provider quota usage; received email and external team clients
are outside application accounting.

ResendMailTransportService.send accepts only neutral MailSubmission content and
a stable idempotency key, plus the caller's AbortSignal. It acquires once, returns
local DEFERRED/PAUSED without HTTP, or performs one HTTP attempt through
ResendMailHttpClient. The caller owns deadlines, durable work and retries; this
boundary does not sleep, queue, retry sends, mutate auth or refund permissions.
An already aborted signal does not consume a permission. An ambiguous network
failure returns OUTCOME_UNKNOWN, never safe retry. REJECTED denotes a non-2xx
HTTP response, not proof of non-delivery for 5xx or unknown provider errors;
providerRestriction separately distinguishes RATE_LIMIT/DAILY_QUOTA/MONTHLY_QUOTA.

Pressure persistence uses bounded fresh transactions and retries only confirmed
aborts. Unknown commit is not blindly retried. The transport preserves the
observed ACCEPTED/REJECTED response and reports pressurePersistence=FAILED if
recording fails; it never replaces accepted delivery with a retryable failure.
A caller must surface/handle this technical failure separately from capacity
waiting. Cross-replica enforcement requires committed pressure state: a failed
write or crash between response receipt and persistence cannot be claimed as a
recorded shared pause. Sender recovery/observability and real crash/commit-loss
validation retain their later integration owners; no second auth queue is added.

At the end of block 3.2 the existing auth raw HTTP class reused the neutral HTTP
client, while auth and MailService integration remained pending. Block 4 migrates
auth as described below; block 5 completes migration of the remaining senders. Block 3.2 tests use actual PostgreSQL services,
independent clients, SQL fault injection and a local HTTP server.

#### Auth worker integration — block 4

ResendAuthenticationEmailAdapter now uses ResendMailTransportService. The old raw
auth transport was removed from MailModule in block 4 and deleted in block 5.
MailService notification/legacy sends use the block 5 owner described below. The auth provider port requires a
beforeSubmission callback. The shared transport invokes it once only after a
committed permission and before HTTP. It may refuse submission with
NOT_SUBMITTED. Auth uses this callback to re-read challenge/envelope and perform
startProcessingAttempt under a fresh owned lease. Challenge -> Delivery row-lock
order and time sampled after waits preserve consumption/lease guards; the new
start/defer decisions ceil PostgreSQL time to milliseconds rather than allowing
submission early through timestamp truncation. No DB lock crosses HTTP I/O.
Already terminal/unavailable proof cancels the owned Delivery; a stale owner
cannot submit or mutate its successor. Once HTTP has returned ACCEPTED, later
challenge consumption does not turn acceptance into a retry or cancellation.

The additive processingAttemptStarted field is false for an unstarted lease and
true after one charged processing start. Claim/reclaim never increments the
counter. Reclaim preserves any previously charged count and attemptedAt; the new
owner charges its own next start. This keeps five attempts, 5/15/30/60-second
backoff with existing jitter, stable idempotency and deterministic payload, while
excluding capacity-only claims from the budget. Preparation/decryption/template
failures and classified pre-submission transient failures still charge their
processing attempt. No decrement/refund, second queue, proof rotation or new
Delivery admission charge is introduced. Unknown start commit does not permit
HTTP or free release of a possibly charged lease; lease-expiry recovery preserves
the persisted count.

DEFERRED, PAUSED and technical pre-submission UNAVAILABLE release only an owned,
unexpired, unstarted lease to PENDING. They preserve attemptedAt, attemptCount,
lastSafeFailureCode, proof, payload version and idempotency. Timed capacity is
persisted as ceil(retryNotBeforeMicros / 1000) milliseconds; gate rechecks the exact
boundary. Scheduling is capped at the first millisecond after the challenge's
minimum-validity cutoff so long pauses cannot strand unfinished work. Claim also
selects unavailable/window-closed challenges even when their schedule is future,
so cancellation progresses without provider permission. Monthly/technical
unknown recovery uses the existing worker interval as a local recheck time, not
as a provider reset promise. The actual shared monthly block still controls all
submission permissions.

Worker summaries distinguish deferredCount from retries/failures. Shared capacity
deferral stops further claims in all lanes of that cycle; already leased lanes
finish normally. A single unref'ed capacity timer preserves subsecond wakeup,
never overlaps active cycles and is stopped with the ordinary interval during
shutdown. The base interval still handles unknown recovery, queue maintenance
and expired leases. A successful shared permission is still spent if final auth
validation refuses HTTP; it is never refunded.

An actual rate/daily/monthly provider rejection consumes the started attempt and
uses the existing retry owner/backoff. Subsequent capacity waiting is free.
Adapter quota codes stay distinct from generic rate limiting and conservatively
retain AMBIGUOUS_RETRY; SAFE_RETRY remains reserved for explicit rate limiting.
Committed shared
Retry-After/quota state applies to all subsequent Deliveries and retries.
Transport ambiguity remains ambiguous, with the same provider key/payload and
five-attempt budget. Pressure persistence failure is safely logged as its own
technical event; ACCEPTED is preserved, while rejected responses retain the
provider retry hint and an ambiguous RESEND_PRESSURE_PERSISTENCE_FAILED code.
The response/persistence crash gap described in block 3.2 is not claimed solved.

Migration rollout requires stopping/draining old delivery workers before applying
20261112040000_separate_auth_delivery_lease_attempt and starting the new version.
It marks existing positive-count PROCESSING rows as already charged and does not
rewrite counts, proof or scheduling. The new CHECK prevents a started flag on
non-PROCESSING/zero-count rows. Do not run mixed worker versions: old transitions
do not clear this flag. Real PostgreSQL/HTTP checks cover independent workers,
no-charge waits, recovery before/after start, five ambiguous attempts, SQL rollback,
post-gate lifecycle/lease races and accepted-send persistence failure. These
checks establish integration behavior, not production throughput or live-provider
fault/load results, which remain later verification work.

#### Durable notification/legacy mail — block 5

All nine former MailService SDK send paths now enqueue NotificationDelivery work;
only ResendMailHttpClient performs provider HTTP, invoked by the common gated
transport. The unused raw auth transport is removed. Existing sendXEmail method
names are retained internally, but their string result is a durable job ID,
never a provider acceptance ID. NotificationService and
AccountDeletionNotificationService prepare owned snapshots and enqueue with
stable domain-event keys; they no longer mark a newly queued job SENT. Existing
HTTP fields/codes remain; the legacy verification success message explicitly says
queued, and its existing verificationEmailSentAt column now records acceptance
into the queue for the unchanged legacy resend cooldown. Password templates and
legacy endpoint removal retain their later roadmap owners.

NotificationDelivery remains the sole notification mail work/audit record.
mailQueuedAt distinguishes new managed jobs from historical metadata. The row
stores mailExpiresAt, a versioned authenticated envelope, next eligibility,
processing lease, attempt counter and started flag. One transaction serializes
an enqueue key, resolves existing work or creates a complete encrypted snapshot;
a crash cannot commit a managed row without its snapshot. A repeat never changes
the persisted content/deadline/key or resurrects terminal work. A lost enqueue
commit acknowledgement may report unavailability, but repeating the same domain
key resolves the committed row rather than creating another send. Auth Delivery
uses its existing queue and is never copied here.

AES-256-GCM uses independent MAIL_DELIVERY_ENCRYPTION_KEYS (32-byte canonical
base64 entries) and MAIL_DELIVERY_ENCRYPTION_ACTIVE_KEY_VERSION, a random 12-byte
IV and 16-byte authentication tag. Protocol 1 authenticates a domain-separated
JSON tuple containing protocol/key versions, job ID, domain idempotency key,
notification type, recipient and absolute expiry. Content and optional proof
guard are encrypted together. Plaintext is transient; no raw verification/reset
secret is stored in row fields, idempotency keys or logs. These high-entropy
legacy-token hashes do not replace the versioned keyed OTP/link protocol, which
is unchanged. Missing retained keys/unknown protocol cause technical deferral
without dropping work; corrupt envelopes fail closed. Keep older key versions
available while pending/restorable jobs require them. Terminal success/failure
wipes ciphertext, IV, tag and envelope versions while retaining the existing
privacy/retention-governed audit metadata.

Legacy verification and password-reset jobs carry encrypted owner/token-hash
bindings. Enqueue derives the deadline from the actual current source record;
after gate waits and before HTTP, processing rechecks token expiry, replacement,
consumption/invalidation, owner/email and applicable account state. Unavailable
proof becomes MAIL_PROOF_UNAVAILABLE without sending. New legacy verification
uses the explicit LEGACY_EMAIL_VERIFICATION notification type. Passwordless OTP
and magic-link emails never enter these legacy guard/snapshot paths.

MAIL_DELIVERY_MAX_AGE_SECONDS has the accepted starting value 82800 (23 hours)
and must be below the 86400-second provider idempotency window and covered by
notification retention. A token's actual expiry may shorten it. Persisted age
starts at DB-authoritative enqueue time and is not extended on claim/retry.
Provider submission always uses the job ID as its stable idempotency key and
the exact stored content. Once the window closes, terminalize and wipe work
rather than inventing a new key or sending early. Five started processing
attempts use fixed 5/15/30/60-second post-completion backoff; valid Retry-After
can only extend it. Unknown HTTP/transport outcomes remain conservative retries;
only known request/auth/configuration rejections terminalize immediately.

MailDeliveryWorkerService is a bounded non-overlapping single lane per replica,
with SKIP LOCKED claims, UUID leases and conditional owner transitions. Leasing
and gate waiting do not charge attempts or overwrite attemptedAt/failureCode.
The common beforeSubmission hook checks the fresh lease, deadline and proof
before atomically marking a started attempt. A crash after that commit spends
the attempt; a crash before it does not. Reclaim preserves the charged counter
and prior attemptedAt, never refunds it and never starts a sixth attempt. No DB
lock spans HTTP. A stale lease cannot mutate a replacement. Shared capacity,
monthly quota or pre-submission technical unavailability preserves PENDING work;
unknown recovery uses a local poll, not a claimed provider reset. Timed deferral
ceils absolute microseconds to milliseconds and caps wakeup at expiry. The
existing interval and an unref'ed subsecond capacity timer stop on shutdown;
shutdown drains active work. Initial settings are lease 45 seconds, HTTP timeout
10 seconds, worker interval 1 second and at most 20 claims per cycle, with
validated execution bounds.

An observed ACCEPTED response is never reclassified as provider failure because
pressure/status persistence failed. Pressure recording failures get a safe event;
if the SENT write itself fails, the charged lease remains for idempotent recovery.
This does not claim atomic provider/database commit, exact network-arrival
spacing, or elimination of the block 3.2 response/persistence crash gap.

Completion mail is fully snapshotted inside the account-finalization transaction
before anonymization and retains its original recipient. Its previous separate
retry/dispatch owner is removed: only the mail worker retries. The existing
finalization summary retriedCompletionDeliveries remains zero for compatibility;
it no longer counts worker attempts. Other post-commit notifications become
reliable once enqueue commits; this block does not promise recovery from a crash
before their enqueue or introduce a universal event outbox. Notification retention
cleanup skips active mail leases using PostgreSQL clock_timestamp(), independent
of the caller-supplied retention cutoff. Block 6's real held-HTTP test reproduces
the old premature deletion with a future cutoff and verifies the correction. Existing rows without mailQueuedAt/envelopes
are preserved unchanged and never guessed/replayed; a duplicate pending/failed
historical key reports enqueue unavailability instead of false queued success.
Such historical work needs explicit review before rollout.

Migration 20261112050000_add_durable_notification_mail is additive and changes no
existing notification state/content. CHECK constraints enforce whole envelopes,
lease/attempt coherence, terminal wiping, five attempts and a sub-24-hour window.
Stop/drain older application workers/finalizers before migration, configure the
independent mail keyring on every replica, then restart the new version. Do not
mix synchronous legacy notification owners with the queued implementation.

Tests cover real PostgreSQL, two independent Nest/Prisma instances and local HTTP:
complete/deduplicated enqueue, encrypted token storage and guards, quota waiting,
lease recovery before/after attempt start, stable ambiguous retries, expiry,
key unavailability/tampering, transaction rollback, post-gate proof changes,
accepted-but-unrecorded recovery, completion after anonymization, auth competition
and additive migration preservation. HTTP account/session/recovery tests now
assert actual persisted PENDING enqueue with background sending disabled; the
separate worker/HTTP suite exercises real sending and transitions without DB or
provider-service mocks. Tests and fault fixtures do not establish live-provider
idempotency, real process/commit-ack loss, production throughput or rollout
readiness. Block 6 verifies internal composition; Iteration 7 retains load,
telemetry, tuning and extended process/network fault verification.

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

### Accepted V1 targeted revocation by an earlier session

Status: **ACCEPTED / FIXED target policy; not implemented.** Permit a currently
authorized active session to revoke a strictly newer active session belonging
to the same User even before its management cooldown expires. This is a limited
exception for targeted revocation, not a declaration that earlier means trusted.

| Acting session / target | Targeted revoke permission |
| --- | --- |
| Active actor, target is itself | Preserve existing logout/revoke behavior |
| Actor within management cooldown, target.createdAt > actor.createdAt | Allow |
| Actor within cooldown, target.createdAt <= actor.createdAt | Deny with existing SESSION_TOO_FRESH contract |
| Actor has completed management cooldown | Preserve existing owned-active-target revocation permission |

For example, owner session A at time zero may revoke session B created thirty
seconds later immediately. B cannot revoke A while B is too fresh. If an attacker
obtains the earlier session instead, the same ordering advantage applies; this
is an explicitly accepted V1 residual risk. Stolen tokens of an existing session
do not necessarily create a new-session alert, and ordering cannot distinguish
the thief from the legitimate client. Do not infer owner identity from device
metadata, IP/GeoIP, notification ownership, or session age alone.

Use persisted server timestamps; ties grant no earlier-session exception. Scope
both actor and target by authoritative userId and active account/session state.
Validate authorization and commit revocation atomically, including concurrent
revocation of the actor. No request-supplied creation time, notification ID, or
push/deep link grants authority. The action from a security notification opens
authenticated session details and uses the existing selected-revocation path.
A successful response must correspond to committed revocation; subsequent
protected access and refresh of that session are rejected. Already executed
requests cannot be undone by revocation.

The exception does not relax rename or revoke-others cooldowns, recent-auth
requirements of other operations, or the strict active-session limit. No
pending approval, temporary/overflow session, automatic session eviction, or
new authenticator is introduced. Notification acknowledgment such as “This was
me” is not an authenticator or permission upgrade.

Integrate as focused session-management work in Stage 7 and connect notification
UX in Stage 9/mobile Stage 11. Cover early-actor/newer-target success, reverse
order denial, equal timestamps, mature actor behavior, ownership/active-state
failures, concurrent actor revocation, access/refresh rejection, and unchanged
rename/revoke-others/session-limit behavior. Existing runtime continues to apply
the old cooldown to all other-session revocation until this change is delivered.

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

### Notification channels — ACCEPTED / FIXED target

Registration creates the user only after successful institutional-email proof.
Its initial session still records `SESSION_CREATED`, but does not generate a
new-session alert. With no resend, registration sends one email containing OTP
and magic link. After account creation, a separate welcome message appears in
the user's Unicon system conversation; this is onboarding, not a session alert.
Registration means creation of a new account, not an existing account having
zero active sessions.

Subsequent successful sign-ins to an existing account create a new-session
in-app message in that same Unicon conversation, with “This was me” / “This was
not me” actions governed by the session-management policy above. Push delivery
targets eligible previously registered devices. There is no new-session email,
including when no previous device can receive push. Sessions do not wait for
notification approval.

Suspicious-activity notifications use an in-app message in the same Unicon
conversation, push to eligible devices, and email. Detection, deduplication,
and notification admission must prevent alert bombing; an arbitrary failed OTP
is not automatically an email alert. A not-yet-created account has no account
notification recipient. Account-deletion requested, cancelled, and completed
notifications retain email delivery.

In-app messages persist independently of push delivery. Push is attempted only
for eligible device registrations and remains subject to platform permissions;
delivery or display cannot be guaranteed. Notification failures never roll back
authentication. Challenge email delivery is different: it is required for the
email proof flow and has an explicit delivery lifecycle. Notification channels
are not OTP/magic-link proof delivery methods.

This is target Stage 9/11 behavior, not the current email-only notification
runtime. Stage 6 must distinguish account creation from subsequent sign-in;
replace the existing new-session email path only when durable in-app delivery
and the corresponding push/mobile integration are ready. No general-purpose
chat implementation is required by this decision.

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
