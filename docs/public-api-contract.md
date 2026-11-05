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
different identity/challenge flow. Successful admission creates a new EMAIL
Delivery containing the same OTP and magic link. It does not create a new challenge or change proof, expiration,
failed attempts, consumption, or lock state.

The new Delivery has `RESEND` origin, a new delivery ID, and a new provider
idempotency key. Creation atomically supersedes prior non-terminal Deliveries
for the challenge and revokes ownership of an old processing worker. That
worker can no longer finalize or mutate its Delivery. Supersession does not
physically cancel an already-submitted provider request, so the user may rarely
receive two messages; both contain the same proof and fixed expiration. This
race does not rotate credentials or weaken verification.

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
| `AUTH_CODE_INVALID`              |  400 | The OTP is incorrect and attempts remain.                                             |
| `AUTH_CHALLENGE_LOCKED`          |  400 | The challenge reached its failed-attempt limit and cannot be reused.                  |
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
challenge locks at 00:05, Request new code at 00:06 returns a cooldown denial
with 54 seconds remaining, not a fresh 60-second wait. After the interval has
elapsed, lock/expiry adds no separate waiting penalty. If admission succeeds,
the replacement challenge and initial Delivery are created atomically with
applicable charges and cooldown state. Denial does not create a replacement
flow. The authoritative cooldown retry-after uses the later applicable identity
or challenge boundary; the response body and header use the same value.

Next-Delivery admission requires at least the configured Stage 3 minimum
remaining validity (V1: 120 seconds), checked before charge or supersession;
proof can remain verifiable after that Delivery window closes. New PENDING
Deliveries become worker-eligible after commit without another client action,
but remain subject to provider restrictions. Changing identity does not carry
over the old email's cooldown or reset other abuse accounting; returning to
a previously used email retains its remaining identity interval; UI navigation
does not cancel a challenge. See auth-architecture.md's accepted next-Delivery
minimum interval for the atomic admission and persistence contract.

`RATE_LIMIT_EXCEEDED` describes broader abuse buckets.

Temporary verification-policy denial applies only to verification operations
covered by the policy. It does not itself prohibit initial requests, Resend, or
Request new code, change account status, revoke sessions, or lock/consume a
challenge. Those operations retain their independent request/Delivery checks;
replacing a challenge does not reset applicable verification abuse state. Keep
this distinct from the existing five-wrong-canonical-OTP challenge lock.

Verification abuse uses independent normalized-identity and IP failure budgets;
both must permit the operation. Identity aggregates applicable failures across
challenges and IPs, while IP aggregates failures across identities. Plan larger
IP capacity for shared networks. Successful verification consumes neither
failure budget, without exempting the request from separate request/resource
limits.

Charge failure budgets for canonical OTP or magic-link proof mismatches against
an eligible challenge with correct purpose/binding. Only OTP mismatch increments
the challenge OTP counter. The fifth wrong canonical OTP charges and locks;
requests to an already locked challenge do not add proof failures. Malformed
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

These are configurable starting values, not a change to the existing challenge
lock after five canonical wrong OTPs. Endpoint coverage, concurrent accounting,
and remaining recovery semantics stay open in Stage 4 Iteration 1.
Stage 5–6 wiring uses the
stable 429 envelope and one retry-after value in body/header. Operational metrics
must not expose proof/identity data or add tracking to the fallback.

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
| `SESSION_TOO_FRESH`     |  403 | The current session cannot yet manage other sessions.                |
| `SESSION_LIMIT_REACHED` |  409 | A new active session would exceed the configured limit.              |

`SESSION_TOO_FRESH` retains `managementAvailableAt` and
`retryAfterSeconds`.

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
