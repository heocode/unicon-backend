# Passwordless Public API Contract

This document defines the approved target public contract for Unicon mobile
authentication, account, and profile integration. Passwordless endpoints are
not considered implemented until runtime behavior, generated OpenAPI, and
database-backed tests match this document.

## Compatibility rules

- Clients branch on stable `code` values, never on English messages.
- `message` is a safe fallback and may change without versioning.
- Error-specific machine-readable context is nested under `details`.
- Adding an optional response field is backward-compatible.
- Removing or renaming a field or code, changing nullability, or changing a
  success status is potentially breaking.
- Mobile clients keep an unknown-code fallback even when generated types use a
  closed enum.
- `User.id` is the stable application identity. Email is not an ownership or
  account-linking key.

No released mobile client or production user depends on the password contract,
so legacy register, password login, verification, recovery, and password-change
endpoints are removed rather than versioned.

## Public error envelope

Every non-2xx JSON response uses:

```json
{
  "code": "AUTH_CHALLENGE_INVALID",
  "message": "The authentication challenge cannot be used."
}
```

Structured details are included only where documented:

```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests. Please try again later.",
  "details": {
    "retryAfterSeconds": 60
  }
}
```

Every 429 response also includes an integer `Retry-After` header. Unhandled
errors return `INTERNAL_ERROR` without stack traces, Prisma errors, provider
responses, configuration, identity data, or proof material.

## Validation errors

Body, path, and query validation failures return HTTP 400:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "The request is invalid.",
  "details": {
    "violations": [
      {
        "field": "email",
        "code": "INVALID_EMAIL",
        "message": "Email must be a valid email address."
      }
    ]
  }
}
```

Stable validation violation codes are:

```text
REQUIRED
INVALID_TYPE
INVALID_EMAIL
INVALID_UUID
INVALID_LENGTH
VALUE_TOO_LONG
UNKNOWN_FIELD
```

`WEAK_PASSWORD` is not part of the v1 contract.

## Authentication challenge contract

### Request or deliver a sign-in challenge

```http
POST /auth/challenges
```

```json
{
  "email": "student@my.centennialcollege.ca"
}
```

`email` is trimmed and lowercased. The domain must match an active
`AllowedDomain`.

For an allowed email, the response does not reveal whether the identity is new,
active, blocked, or deletion-scheduled. An existing reusable live `SIGN_IN`
challenge for the same identity and purpose is returned without automatically creating another EMAIL Delivery or charging
Delivery quota/cooldown. Explicit Resend requests the next Delivery. A newly
created challenge receives its initial Delivery only when admission permits.

Success is HTTP 202:

```json
{
  "challengeId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresInSeconds": 600,
  "resendAvailableInSeconds": 60
}
```

`expiresInSeconds` is the remaining challenge lifetime. It is not reset by
repeated requests or deliveries. For a reused challenge,
`resendAvailableInSeconds` reports remaining authoritative cooldown, rather than
resetting it to 60. Response/error details for closed Delivery eligibility and
other admission outcomes are finalized in Stage 5.

### Resend the existing proof

```http
POST /auth/challenges/:challengeId/resend
```

Resend has no body and never accepts a replacement recipient. The recipient
comes from authoritative challenge identity state; another email requires a
different identity/challenge flow. ACCEPTED / FIXED V1 target: if an eligible
challenge already has a PENDING or PROCESSING Delivery, return/resolve that work
as awaiting/in-progress, without new Delivery, supersession, lease/retry changes,
Delivery quota charge, or cooldown movement. Request-level accounting remains.

Otherwise, successful admission creates a new EMAIL Delivery with RESEND origin,
a new ID and provider idempotency key, carrying the same stable proof. Lifecycle,
delivery window, cooldown, Delivery quotas, global rate, and backlog must allow
creation. At most one unfinished Delivery may exist per challenge, including
under concurrent requests. Temporary provider gate exhaustion alone does not
prohibit admission; it can leave accepted work waiting. Exact response fields
for existing-work resolution remain Stage 5 HTTP integration work.

`SIGN_IN` resend is public and protected by identity/IP/challenge limits.
`STEP_UP` resend additionally requires the same active access session to which
the challenge is bound.

Success is HTTP 202:

```json
{
  "challengeId": "550e8400-e29b-41d4-a716-446655440000",
  "expiresInSeconds": 421,
  "resendAvailableInSeconds": 60
}
```

### Verify the six-digit OTP

```http
POST /auth/challenges/:challengeId/verify-otp
```

```json
{
  "code": "123456"
}
```

The code must be exactly six decimal digits. Session metadata headers are
accepted. Successful proof atomically consumes the shared challenge, resolves
or creates the user, creates a session, and returns HTTP 201:

```json
{
  "accessToken": "...",
  "refreshToken": "..."
}
```

The response deliberately omits `accountCreated`; mobile bootstraps through
`GET /profile/me` and `onboardingCompleted` rather than branching on auth
history.

If proof succeeds but the active-session limit prevents creation, the
challenge remains consumed and the endpoint returns `SESSION_LIMIT_REACHED`
with the recovery details defined below.

### Verify the magic link

```http
POST /auth/challenges/:challengeId/verify-link
```

```json
{
  "token": "<opaque 256-bit token>"
}
```

Session metadata headers are accepted. Success and session semantics are
identical to OTP verification. OTP and magic link share one consumption state;
using either makes both unusable.

Repeated clicks on a valid link must not spend verification failure budgets:
success is uncharged and replay of consumed/expired proof is not a proof
mismatch. Concurrent valid exchanges create at most one session; losing requests
do not become wrong-token failures. Clients prevent duplicate in-flight POSTs
and automatic retry loops; GET/prefetch alone never exchanges proof. HTTP requests
still remain subject to independent request limits, so unlimited clicking is
not guaranteed. Repeated canonical wrong tokens for eligible challenges remain
chargeable failures. Replay does not create another session or expose raw
previously issued tokens.

The canonical email link is:

```text
https://uniconnection.app/auth/verify?challengeId=<canonical UUID>&token=<canonical magic-link token>
```

The backend source URL is configured with the exact value
`AUTH_MAGIC_LINK_PUBLIC_URL=https://uniconnection.app/auth/verify`. Alternate
schemes, hosts, paths (including a trailing slash), query parameters, and
fragments are invalid configuration and are not silently normalized.

`uniconnection.app` is a client-neutral public origin for iOS, Android, and
future web authentication. `GET /auth/verify` opens the native app or safe
fallback page but never verifies proof, consumes the challenge, creates a user,
or creates a session. The client submits the proof through the POST endpoint
above, then chooses its destination from the challenge purpose and returned
state. The auth route has no analytics, prevents referrer leakage, and removes
the token from the browser URL as early as possible.

The fallback document has no third-party resources, validates both canonical
parameters, retains the token only in memory, and immediately removes the
query string with `history.replaceState` before rendering normal UI. Loading
the document does not submit proof; verification requires a separate explicit
POST action. A reload after URL cleanup does not restore the token.

The fallback response uses `Referrer-Policy: no-referrer`, `Cache-Control:
no-store`, a restrictive Content Security Policy, and search-engine exclusion.
Infrastructure and application logging must redact the `token` query value and
must not capture the full URL in analytics, error reporting, crash reporting,
or session replay. The origin exposes the required iOS and Android association
files under `/.well-known/`, scoped to the authentication route. Client-side
validation does not replace the endpoint's canonical UUID and token validation.

Normal application logs contain structured identifiers and outcomes rather
than a full magic-link URL. URL redaction is defense in depth for exceptional
boundaries, not the ordinary observability path.

### Deletion-scheduled result

A successful `SIGN_IN` proof for a deletion-scheduled account creates no
session and returns HTTP 409:

```json
{
  "code": "ACCOUNT_DELETION_SCHEDULED",
  "message": "Account deletion is scheduled.",
  "details": {
    "deletionScheduledAt": "2026-10-01T12:00:00.000Z",
    "canCancel": true,
    "continuationToken": "...",
    "continuationExpiresInSeconds": 600
  }
}
```

The continuation is single-use and purpose-bound to explicit deletion
cancellation. It is not an access or refresh token.

## Challenge DTOs

```text
RequestAuthenticationChallengeDto
└── email: normalized valid email

ChallengeParamsDto
└── challengeId: UUID

VerifyOtpDto
└── code: exactly six decimal digits

VerifyMagicLinkDto
└── token: bounded opaque string with exact generated representation

AuthenticationChallengeResponseDto
├── challengeId: UUID
├── expiresInSeconds: positive integer
└── resendAvailableInSeconds: non-negative integer

AuthTokensResponseDto
├── accessToken: string
└── refreshToken: string

RecentAuthenticationResponseDto
├── authenticatedAt: date-time
└── recentAuthenticationExpiresAt: date-time

CancelAccountDeletionDto
└── continuationToken: bounded opaque string
```

## Authentication error codes

| Code                             | HTTP | Meaning                                                                               |
| -------------------------------- | ---: | ------------------------------------------------------------------------------------- |
| `EMAIL_DOMAIN_NOT_ALLOWED`       |  400 | The normalized domain is not currently eligible.                                      |
| `AUTH_CHALLENGE_INVALID`         |  400 | The challenge is missing, consumed, superseded, wrong-purpose, or otherwise unusable. |
| `AUTH_CHALLENGE_EXPIRED`         |  400 | The fixed challenge lifetime elapsed; request a new challenge.                        |
| `AUTH_CODE_INVALID`              |  400 | The OTP is incorrect; retry is subject to verification policies.                                             |
| `AUTH_DELIVERY_COOLDOWN`         |  429 | Another delivery is not yet allowed.                                                  |
| `AUTH_EMAIL_UNAVAILABLE`         |  503 | Required email delivery could not be accepted.                                        |
| `RECENT_AUTHENTICATION_REQUIRED` |  403 | A sensitive operation requires a fresh proof.                                         |
| `AUTH_CONTINUATION_INVALID`      |  400 | A purpose-bound continuation is invalid, expired, consumed, or wrong-purpose.         |

`AUTH_CODE_INVALID` never returns attempts remaining. Exposing that counter is
not necessary for the client and helps attackers optimize guesses.

Unknown, blocked, and deletion-scheduled identities receive the same successful
challenge request shape. Account-state errors appear only after successful
proof.

## Rate limiting

| Code                  | HTTP | Meaning                                                                        |
| --------------------- | ---: | ------------------------------------------------------------------------------ |
| `RATE_LIMIT_EXCEEDED` |  429 | An identity, IP, device, verification, or provider pressure limit was reached. |

All 429 responses contain `details.retryAfterSeconds` and `Retry-After`.

The public passwordless POST routes (challenge request, resend, verify-otp, and
verify-link) share one canonical-source-IP request GCRA bucket. Each request
admitted by that policy costs one before JSON parsing/DTO validation/domain services,
regardless of the later response. Downstream validation/domain denial or failure
does not refund request capacity. Request-policy denial returns
RATE_LIMIT_EXCEEDED (429) without running the domain operation or advancing TAT.
Body/header use one authoritative retry-after; infrastructure unavailability
is a fail-closed technical error instead of a fabricated 429.

Initial request GCRA settings are burst 200 and sustained rate 600 requests per
60 seconds per canonical source IP, recovering one allowance per 100 milliseconds.
There is no additional timed block/full reset, and these values are not a strict
600-per-minute quota. Settings are configurable and will be validated under
load and tuned from pilot/production analytics, not hardcoded by clients.
ACCEPTED / FIXED V1: malformed JSON consumes only the admitted HTTP request
capacity, not verification/Delivery budgets, and does not mutate the challenge.
Request-policy denial stops before JSON parsing. There is no separate malformed
limiter in V1. Shared-IP clients can consume one another's request allowance;
this policy does not guarantee per-user fairness. Source selection occurs at the
HTTP boundary under explicit trusted-proxy configuration; a separate reusable
canonicalizer strictly validates one IP literal with ipaddr.js, maps IPv4-mapped
IPv6 to IPv4, normalizes IPv6, and retains private/loopback addresses. All IP
policies use the same canonical value with independent budgets. Missing or
untrustworthy source IP or failed canonicalization fails closed as technical
failure, not quota denial; exact public mapping remains open. Arbitrary-header
fallback and address guessing are not supported. IPv6 prefix policies are
deferred. ACCEPTED / FIXED deployment boundary: direct mode uses socket peer IP
and ignores forwarding headers. Proxy-only mode requires a trusted immediate
peer; chain resolution walks trusted hops right to left, while single-IP headers
require authoritative ingress sanitization. Required-source failure does not
fall back to other headers or socket IP. Reject missing/contradictory required
production trust configuration at startup; verify actual topology, sanitization,
and origin-bypass protection before staging. Exact proxy ranges/header mechanism,
concrete pre-parser wiring, and public source-failure mappings remain integration
work; this target contract changes no runtime configuration.
This group does not implicitly include other product APIs, refresh/protected
sessions, separate STEP_UP routes, or GET /auth/verify. Request accounting is
independent of Delivery admissions and proof-failure budgets; denial from one
does not imply that their counters share state.

`AUTH_DELIVERY_COOLDOWN` describes the challenge- and identity-scoped Delivery
minimum intervals: 60 seconds between authoritative admission timestamps of
successfully committed admissions, not between commit timestamps. It applies to every path
creating the next Delivery; repeated initial requests only return the reusable
challenge. The first admitted Delivery establishes cooldown. Provider results
do not start, reset, or refund it. Denial leaves the boundary, existing Delivery,
lease, proof, expiration, and OTP failure count unchanged. Body and header use
one DB-authoritative retry-after result.

For the same normalized email, initial, Resend, and Request new code must also
respect a shared 60-second admission interval across challenges. A new challenge
does not reset this boundary. If a Delivery was admitted at 00:00 and the
user submits wrong OTPs at 00:05, Resend at 00:06 returns a cooldown denial
with 54 seconds remaining, not a fresh 60-second wait. After the interval has
elapsed, expiry adds no separate waiting penalty. Wrong OTPs do not force a
new challenge in the target flow. If admission succeeds,
the replacement challenge and initial Delivery are created atomically with
applicable charges and cooldown state. Denial does not create a replacement
flow. The authoritative cooldown retry-after uses the later applicable identity
or challenge boundary; the response body and header use the same value.

Next-Delivery admission requires at least the configured Stage 3 minimum
remaining validity (V1: 120 seconds), checked before charge or creation;
proof can remain verifiable after that Delivery window closes. New PENDING
Deliveries become worker-eligible after commit without another client action,
but remain subject to provider restrictions. Changing identity does not carry
over the old email's cooldown or reset other abuse accounting; returning to
a previously used email retains its remaining identity interval; UI navigation
does not cancel a challenge. See auth-architecture.md's accepted next-Delivery
minimum interval for the atomic admission and persistence contract.

`RATE_LIMIT_EXCEEDED` describes broader abuse buckets.

Email Delivery admission uses GCRA burst capacity 10 with sustained rate 7 per
3600 seconds, replenishing one allowance per 3600/7 seconds (about 8 minutes
34.286 seconds). Initial, Resend, and replacement initial Delivery share the
normalized email budget across challenges/IPs. Each committed new Delivery
charges one unit; resolution without a Delivery, denial, rollback, and retries
of an existing Delivery do not. Provider failure does not refund a committed
admission. This is not a strict seven/hour or ten/hour quota and has no fixed
hourly reset or extra timed penalty. Parameters remain configurable.

Check this budget alongside the 60-second minimum interval, Delivery validity,
and other applicable budgets. Charge/cooldown/creation must be
atomic. Denial leaves existing proof and Delivery unchanged and does not itself
prohibit verification. New challenges do not reset email rate debt. Round public
retry-after upward from authoritative state, without recomputing it in the
client. Combined admission error precedence remains open for the owning
Stage 4/5 decisions.

IP Delivery admission independently uses GCRA burst capacity 120 and rate 240
admitted Deliveries per 3600 seconds (one allowance per fifteen seconds), shared
across emails/challenges/clients from that source IP. Each committed initial,
Resend, or replacement initial Delivery charges both email and IP budgets by
one. Both must allow admission; denial or rollback neither partially charges
these budgets nor supersedes existing work. Provider retries do not charge
again and later provider failure does not refund. Identity/challenge changes
do not reset IP TAT. Preserve the independent 60-second email/challenge interval
and other admission/provider restrictions. This is a configurable burst-plus-rate
policy, not a strict hourly quota; shared-IP exhaustion denies new Deliveries,
not verification of existing proof by itself.

Temporary verification-policy denial applies only to verification operations
covered by the policy. It does not itself prohibit initial requests, Resend, or
Request new code, change account status, revoke sessions, or lock/consume a
challenge. Those operations retain their independent request/Delivery checks;
replacing a challenge does not reset applicable verification abuse state. Keep
this distinct from challenge expiry/consumption. The target no longer
permanently locks a challenge after five OTP failures; runtime transition is
gated on implemented verification enforcement.

Verification abuse uses independent normalized-identity and IP failure budgets;
both must permit the operation. Identity aggregates applicable failures across
challenges and IPs, while IP aggregates failures across identities. Plan larger
IP capacity for shared networks. Successful verification consumes neither
failure budget, without exempting the request from separate request/resource
limits.

Charge failure budgets for canonical OTP or magic-link proof mismatches against
an eligible challenge with correct purpose/binding. Only OTP mismatch increments
a diagnostic challenge OTP counter if retained. Fifth and later wrong canonical
OTPs are accounted for when GCRA permits, without locking the target challenge.
Requests to historical terminal locked rows do not add proof failures. Malformed
proof, missing/expired/consumed challenges, purpose/binding rejection, policy
denial, and infrastructure errors do not spend these failure budgets, but their
requests remain subject to separate request protection. These are internal
accounting distinctions, not permission to expose internal unavailability reasons
or remaining attempt counts in public responses.

Short-term verification uses GCRA with independent identity and IP buckets:
identity burst capacity 6 with sustained replenishment of 6 failures per 60
seconds; IP burst capacity 72 with rate 72 per 60 seconds. These are burst-plus-
rate limits, not strict maxima in every rolling minute. Only chargeable proof
mismatches consume capacity; success, excluded outcomes, and policy denials do
not advance rate debt (TAT).

Insufficient capacity temporarily denies covered verification until eligibility
returns, without an additional 60-second denial or full-reset timer. Identity
recovers one allowance per ten seconds; IP one per 5/6 second. The authoritative
retry-after covers the latest applicable blocking boundary and is rounded up
for HTTP seconds. Denied retries do not extend waiting. Clients may disable
submission/input and show “Too many requests” with the remaining wait; backend
checks remain authoritative. Do not expose internal failure budgets or TAT.

New challenges do not reset identity/IP rate debt. Recovery does not unlock
old challenges, reset independent long-term state, or override other policies.
GCRA values are configurable operational settings, not client-side constants.
Long-term identity verification independently uses GCRA burst capacity 8 with
sustained rate 12 failures per 3600 seconds (one allowance per 300 seconds).
It shares the accepted proof-failure classification and aggregates across IPs
and challenges. Short-term recovery and challenge replacement do not reset its
TAT. It must permit verification alongside short-term identity/IP policies;
retry-after reflects the latest applicable blocking eligibility time. Success,
denial, and excluded outcomes do not charge it. There is no added timed penalty
or full-reset timer. This is not a strict failures-per-hour quota. Burst eight
replaces the earlier burst-twelve setting; sustained rate remains 12/hour.

Long-term IP verification independently uses GCRA burst capacity 360 with rate
360 chargeable failures per 3600 seconds, recovering one allowance per ten
seconds. Aggregate accepted mismatches across identities and challenges on that
IP. Preserve short-term IP burst 72/rate 72 per minute; this long-term setting
is not a strict 360-per-hour quota. Keep all four verification TAT states
independent. All policies must allow verification, and retry-after reflects the
latest applicable blocking eligibility. Success, excluded outcomes, and denied
requests do not advance TAT. Challenge/identity changes and short-term recovery
do not reset long-term IP debt. No additional timed penalty/reset applies.

**ACCEPTED / FIXED target:** replace the automatic five-wrong-OTP challenge
lock with GCRA verification admission. Wrong OTPs do not clear proof, invalidate
magic link, cancel Delivery, or require a new email solely due to failure count.
On policy denial, return RATE_LIMIT_EXCEEDED (429) and authoritative retry-after;
clients may disable submission and display the wait. After capacity returns,
verify the same challenge if still live, correctly bound, and unconsumed. At
expiry use AUTH_CHALLENGE_EXPIRED and the new-code flow. Do not promise a full
600 seconds after waiting or Resend. AUTH_CHALLENGE_LOCKED is removed from the
target error catalog, not from current runtime by documentation alone.

Gate runtime lock removal on integrated, verified GCRA enforcement; never run
unthrottled proof verification during transition. Authoritative limiter failure
is fail-closed technical unavailability, not policy denial/429 or a new challenge
lock. No session is issued when the required admission/charging cannot be
completed. Preserve the challenge on a technical failure according to atomic
rollback semantics; exact technical error mapping is finalized in Stage 5–6.

Policy values remain configurable. Endpoint coverage, concurrent accounting,
and remaining recovery semantics stay open in Stage 4 Iteration 1.
Stage 5–6 wiring uses the
stable 429 envelope and one retry-after value in body/header. Operational metrics
must not expose proof/identity data or add tracking to the fallback.

## Global Delivery Admission outcomes (internal target)

ACCEPTED / FIXED internal outcomes: GLOBAL_RATE_DENIED has authoritative
retryAfter from persisted global limiter state; DELIVERY_CAPACITY_UNAVAILABLE
has no known exact backlog-release time; INFRASTRUCTURE_FAILURE is technical
failure, not a policy denial. HTTP statuses, public error codes, and retry UX
for these outcomes remain Stage 5–6 work; these names do not add public errors.

Reliably established denial creates no new work and leaves no partial admission
charges/cooldown/challenge/Delivery changes. Existing unfinished-work resolution
is not new admission. A lost PostgreSQL commit acknowledgment does not establish
rollback: reconcile or safely retry without duplicate admission or repeated
charges, including when earlier admitted work has since completed. Do not claim
nothing was admitted or refund mutations solely because the connection failed.
No public idempotency field is introduced by this documentation decision.

## Access and refresh tokens

| Code                     | HTTP | Meaning                                                        |
| ------------------------ | ---: | -------------------------------------------------------------- |
| `ACCESS_TOKEN_REQUIRED`  |  401 | An access bearer token was not supplied.                       |
| `ACCESS_TOKEN_INVALID`   |  401 | The access token is malformed, invalid, or has the wrong type. |
| `ACCESS_TOKEN_EXPIRED`   |  401 | The access JWT expired and may be refreshed.                   |
| `REFRESH_TOKEN_REQUIRED` |  401 | A refresh bearer token was not supplied.                       |
| `REFRESH_TOKEN_INVALID`  |  401 | The refresh credential or session cannot refresh.              |
| `REFRESH_TOKEN_EXPIRED`  |  401 | The refresh JWT or server-side session expired.                |
| `REFRESH_TOKEN_REUSED`   |  401 | A previously rotated refresh token was presented.              |

Except for `ACCESS_TOKEN_EXPIRED`, clients clear affected local authentication
state and start a new email challenge. Refresh requests for one session are
serialized client-side; successful rotation atomically replaces both tokens.

## Session errors

| Code                    | HTTP | Meaning                                                              |
| ----------------------- | ---: | -------------------------------------------------------------------- |
| `SESSION_UNAVAILABLE`   |  401 | The authenticated session is missing, revoked, expired, or inactive. |
| `SESSION_NOT_FOUND`     |  404 | An owned active target session was not found.                        |
| `SESSION_TOO_FRESH`     |  403 | The current session is too new for the requested management action.                |
| `SESSION_LIMIT_REACHED` |  409 | A new active session would exceed the configured limit.              |

`SESSION_TOO_FRESH` retains `managementAvailableAt` and
`retryAfterSeconds`.

**ACCEPTED / FIXED target:** DELETE /auth/sessions/:sessionId permits an active
authorized session within management cooldown to revoke an owned active target
when target.createdAt is strictly later than actor.createdAt, using persisted
server timestamps. An equal/earlier target retains SESSION_TOO_FRESH. Self-revoke
and mature-session behavior are preserved; rename/revoke-others still use their
existing cooldowns. This ordering exception is not proof that the actor is the
legitimate owner and accepts the case where an attacker holds the earlier
session. Backend actor/target checks and mutation must be atomic.

Security-notification actions use this authenticated endpoint and do not grant
additional authority through a push payload or link. “This was me” only
acknowledges the notification. New sessions do not wait for notification approval.
Committed revocation prevents subsequent protected requests and refresh, without
undoing completed actions. This is target Stage 7/9 integration; the current
runtime cooldown remains until implementation. The strict session-limit contract
below is unchanged.

After successful proof, `SESSION_LIMIT_REACHED` contains the active-session
limit only. The challenge remains consumed, no session is created, and the new
client receives neither session data nor session-management authority.

```json
{
  "code": "SESSION_LIMIT_REACHED",
  "message": "The active session limit has been reached.",
  "details": {
    "activeSessionLimit": 10
  }
}
```

The user must open an already authorized device, revoke one active session
through the normal session-management API, and then start sign-in again with a
new challenge. V1 has no overflow session, automatic eviction, or unauthenticated
session-recovery endpoint.

## Security notification channels (target)

New-account registration generates no new-session alert. Without resend, its
only email is the OTP/magic-link email; a separate onboarding welcome message
appears in the Unicon system conversation after account creation.

Subsequent sign-ins to an existing account generate an in-app new-session
message in that same conversation and push to eligible previous devices, with
“This was me” / “This was not me” actions under the session policy above.
There is no new-session email, including when no previous session/device exists.
Suspicious activity uses the same conversation plus push and email.
Account-deletion requested, cancelled, and completed retain email delivery.

In-app messages remain accessible independently of push permissions or delivery.
Notification failure does not undo authentication. These are Stage 9/11 target
channels, not claims of current runtime support; no notification HTTP endpoints
or response fields are introduced by this documentation decision.

## Account and profile state errors

| Code                                    | HTTP | Meaning                                                                     |
| --------------------------------------- | ---: | --------------------------------------------------------------------------- |
| `ACCOUNT_UNAVAILABLE`                   |  403 | A proven account cannot perform the requested flow.                         |
| `ACCOUNT_STATE_CHANGED`                 |  409 | A concurrent account transition invalidated the operation.                  |
| `ACCOUNT_DELETION_SCHEDULED`            |  409 | Proven account deletion is scheduled and may require explicit cancellation. |
| `ACCOUNT_DELETION_GRACE_PERIOD_EXPIRED` |  409 | The cancellation deadline passed.                                           |
| `ACCOUNT_DELETION_ALREADY_CANCELLED`    |  409 | A concurrent or prior request already restored the account.                 |
| `PROFILE_UNAVAILABLE`                   |  409 | The authorized profile became unavailable.                                  |
| `RESOURCE_NOT_FOUND`                    |  404 | No public route or resource matches the request.                            |

## Account deletion contract

### Refresh recent authentication

An authenticated session older than the recent-auth window requests a
session-bound step-up challenge:

```http
POST /auth/step-up/challenges
Authorization: Bearer <access token>
```

There is no body. Success is HTTP 202 with
`AuthenticationChallengeResponseDto`. Delivery goes to the active
institutional email already bound to the authenticated `User.id`; the client
cannot choose an address.

The client verifies the stable proof through one of:

```text
POST /auth/step-up/challenges/:challengeId/verify-otp
POST /auth/step-up/challenges/:challengeId/verify-link
```

Both require the same active access session to which the challenge is bound.
OTP and link request bodies match the sign-in DTOs. Success consumes the shared
challenge, updates that session's `authenticatedAt` and
`authenticationMethod`, and returns HTTP 200:

```json
{
  "authenticatedAt": "2026-09-01T12:00:00.000Z",
  "recentAuthenticationExpiresAt": "2026-09-01T12:10:00.000Z"
}
```

It does not create a new session or rotate access/refresh tokens. Resend uses
`POST /auth/challenges/:challengeId/resend`; for `STEP_UP`, the same bound
access session is required.

### Request deletion

```http
POST /account/deletion
Authorization: Bearer <access token>
```

There is no request body. The server reads the authenticated session and
requires `authenticatedAt` within the configured 600-second recent-auth window.

Success remains HTTP 202:

```json
{
  "status": "DELETION_SCHEDULED",
  "deletionScheduledAt": "2026-10-01T12:00:00.000Z",
  "gracePeriodSeconds": 2592000
}
```

All sessions are immediately revoked and the client discards local tokens.

### Explicitly cancel deletion

```http
POST /account/deletion/cancel
```

```json
{
  "continuationToken": "..."
}
```

The continuation comes only from a successful `SIGN_IN` proof for the
deletion-scheduled account. Success atomically restores `ACTIVE`, consumes the
purpose-bound continuation, creates one new session, and returns HTTP 200:

```json
{
  "status": "ACTIVE",
  "deletionCancelled": true,
  "accessToken": "...",
  "refreshToken": "..."
}
```

No old session or token becomes valid again.

## Endpoint inventory

| Endpoint                                                 | Request DTO                         | Success DTO                           | Status | Authentication / headers                             |
| -------------------------------------------------------- | ----------------------------------- | ------------------------------------- | -----: | ---------------------------------------------------- |
| `POST /auth/challenges`                                  | `RequestAuthenticationChallengeDto` | `AuthenticationChallengeResponseDto`  |    202 | Public request IP and informational metadata         |
| `POST /auth/challenges/:challengeId/resend`              | `ChallengeParamsDto`                | `AuthenticationChallengeResponseDto`  |    202 | Public request IP and informational metadata         |
| `POST /auth/challenges/:challengeId/verify-otp`          | params + `VerifyOtpDto`             | `AuthTokensResponseDto`               |    201 | Session metadata headers                             |
| `POST /auth/challenges/:challengeId/verify-link`         | params + `VerifyMagicLinkDto`       | `AuthTokensResponseDto`               |    201 | Session metadata headers                             |
| `POST /auth/step-up/challenges`                          | none                                | `AuthenticationChallengeResponseDto`  |    202 | Access bearer token                                  |
| `POST /auth/step-up/challenges/:challengeId/verify-otp`  | params + `VerifyOtpDto`             | `RecentAuthenticationResponseDto`     |    200 | Bound access bearer token                            |
| `POST /auth/step-up/challenges/:challengeId/verify-link` | params + `VerifyMagicLinkDto`       | `RecentAuthenticationResponseDto`     |    200 | Bound access bearer token                            |
| `POST /auth/refresh`                                     | none                                | `AuthTokensResponseDto`               |    201 | Refresh bearer token                                 |
| `POST /auth/logout`                                      | none                                | none                                  |    204 | Access bearer token                                  |
| `GET /auth/sessions`                                     | none                                | `SessionsResponseDto`                 |    200 | Access bearer token                                  |
| `PATCH /auth/sessions/:sessionId`                        | params + `UpdateSessionDto`         | `UpdateSessionResponseDto`            |    200 | Access bearer token                                  |
| `DELETE /auth/sessions/others`                           | none                                | `RevokeOtherSessionsResponseDto`      |    200 | Access bearer token                                  |
| `DELETE /auth/sessions/:sessionId`                       | params                              | none                                  |    204 | Access bearer token                                  |
| `POST /account/deletion`                                 | none                                | `AccountDeletionResponseDto`          |    202 | Access bearer plus recent authentication             |
| `POST /account/deletion/cancel`                          | `CancelAccountDeletionDto`          | `AccountDeletionCancelledResponseDto` |    200 | Purpose-bound continuation; session metadata headers |
| `GET /profile/me`                                        | none                                | `ProfileResponseDto`                  |    200 | Access bearer token                                  |

The following endpoints do not exist in the target v1 contract:

```text
POST  /auth/register
POST  /auth/login
POST  /auth/verify-email
POST  /auth/resend-verification
POST  /auth/forgot-password
POST  /auth/reset-password
PATCH /account/password
```

## Session metadata headers

Challenge verification and deletion cancellation accept the existing bounded,
informational headers:

```text
User-Agent
X-Device-Model-Identifier
X-Device-Model
X-Platform
X-OS-Version
X-App-Version
```

Supported platforms remain `IOS`, `ANDROID`, `WEB`, and `UNKNOWN`. Metadata is
optional, may be spoofed, and is never proof or a trusted-device credential.

## Swagger and mobile requirements

- Every endpoint declares an explicit success DTO or empty 204 response.
- Access and refresh bearer schemes remain distinct.
- Challenge IDs, OTPs, link tokens, and continuations are documented as
  different values with different security properties.
- Examples never contain real secrets and never imply that `GET` consumes a
  magic link.
- Every documented error references the shared envelope and typed details.
- OpenAPI contract tests verify response schemas, security requirements,
  endpoint removal, and absence of persistence/security fields.
- iOS configures the OTP input as a one-time-code field.
- Android supports normal autofill, notification copy, clipboard paste, and
  App Links without requesting mailbox access.
- The mobile client stores `challengeId` only for the active flow and clears it
  after consumption, terminal failure, or expiry.
