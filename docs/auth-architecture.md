# Auth Architecture

This document describes the implemented auth and session architecture. It is a
statement of current behavior, not the future roadmap. Planned work is tracked
in `auth-roadmap.md`.

## Product identity model

Unicon is restricted to students with an email domain present in
`AllowedDomain` and marked active. Registration creates a `PENDING` user and
sends a verification email. Successful verification activates the account and
creates its first session.

OAuth is intentionally excluded. A third-party identity does not prove control
of an allowed college email and would add account-linking risk without removing
the verification requirement.

## Module responsibilities

- `AuthController` owns the `/auth` HTTP boundary.
- `AuthService` coordinates registration, login, session, and verification
  flows.
- `PasswordModule` owns the shared password hashing and comparison primitive
  used by authentication and future account/recovery flows.
- `SecureTokenService` creates and hashes opaque security tokens.
- `JwtTokenService` signs access and refresh JWTs.
- Session behavior is grouped under `auth/session` and split by responsibility:
  - `SessionCreationService` owns expiration, the active-session limit,
    serializable creation, transaction-conflict retries, and creation events;
  - `SessionRefreshService` owns refresh-token validation, atomic rotation,
    sliding expiration, reuse detection, and the resulting alert;
  - `SessionAuthorizationService` owns the minimal active-session check used
    by protected requests;
  - `SessionQueryService` owns the public active-session list;
  - `SessionManagementService` owns naming, individual and bulk revocation,
    the fresh-session cooldown, and revocation events.
- `EmailVerificationService` owns verification-token lifecycle and activation.
- `AccessTokenGuard` verifies access JWTs and checks the referenced active
  session.
- `AuthSecurityModule` packages access-token verification and session
  authorization for protected domain modules without exposing registration,
  login, or refresh orchestration.
- `RefreshTokenGuard` verifies refresh JWTs and exposes the original token to
  the refresh flow.
- `GeoIpModule` is infrastructure shared with auth. `GeoIpService` resolves a
  public IP through a locally mounted MaxMind MMDB.
- `SecurityModule` owns the append-only security-event journal and its
  retention boundary. It does not send notifications or calculate risk.
- `NotificationModule` owns best-effort notification orchestration and delivery
  status. `MailModule` remains the Resend infrastructure adapter.
- `AccountModule` owns authenticated account-management flows. Password change
  keeps the caller's session, revokes other active sessions, and records the
  security event atomically.
- `PasswordRecoveryService` owns reset-token issuance and consumption,
  password replacement, and unconditional revocation of every session after
  recovery. Recovery does not create a session; the user signs in again.
- `RecoveryRateLimitService` owns database-backed password-reset request
  limits. Email and IP bucket inputs are stored only as keyed hashes.
- `PrismaService` is the database boundary.

Controllers must stay thin. Cross-service orchestration belongs in
`AuthService`; specialized behavior belongs in its owning service.

## Current HTTP surface

The current auth controller exposes:

```text
POST  /auth/register
POST  /auth/login
POST  /auth/verify-email
POST  /auth/resend-verification
POST  /auth/forgot-password
POST  /auth/reset-password
POST  /auth/refresh
POST  /auth/logout
GET   /auth/sessions
PATCH /auth/sessions/:sessionId
DELETE /auth/sessions/:sessionId
DELETE /auth/sessions/others
PATCH /account/password
GET   /profile/me
```

`GET /auth/sessions`, session naming, logout, and other protected endpoints use
the access-token guard.

## Validation boundary

Application bootstrap applies the shared configuration from
`src/configure-app.ts`. Its global `ValidationPipe` transforms DTOs, strips no
unknown values silently, and rejects non-whitelisted properties.

Login and verification session metadata is extracted at the controller
boundary by `SessionContext`. It normalizes and bounds:

```text
request.ip
User-Agent
X-Device-Model-Identifier
X-Device-Model
X-Platform
X-OS-Version
X-App-Version
```

Supported platforms are `IOS`, `ANDROID`, `WEB`, and `UNKNOWN`. Client metadata
is informational and can be spoofed. The technical model identifier is trimmed
and bounded to 128 characters; the display model is bounded to 100 characters.
Only the first header value is used, empty values are omitted, and metadata
containing control characters is discarded. Invalid optional device metadata
does not reject an otherwise valid authentication flow.

## Registration and email verification

Registration flow:

```text
RegisterDto validation
→ confirm passwords match
→ reject an existing email
→ verify active AllowedDomain
→ hash password
→ generate verification token and hash
→ create PENDING user
→ send verification email
```

The raw verification token is sent by email; only its hash is stored. Email
delivery is an external operation and is not transactional with user creation.
If delivery fails, a `PENDING` user may remain and can use resend verification.

Verification flow:

```text
hash submitted token
→ locate valid pending user
→ activate user and clear verification fields
→ create Session
→ return access and refresh tokens
```

## Login and tokens

Password login:

```text
normalize email
→ find user
→ compare password hash
→ reject PENDING/BLOCKED/DELETED state
→ collect bounded session metadata
→ best-effort GeoIP lookup
→ atomically verify the active-session limit
→ create Session
→ return token pair
```

Session creation uses a serializable transaction to count the user's active,
unexpired sessions and create the new session as one concurrency-safe
operation. The configurable `SESSION_ACTIVE_LIMIT` is currently 10. At the
limit, login returns `SESSION_LIMIT_REACHED`; no existing session is silently
revoked. Until a separate verified recovery flow is implemented, the user must
use an already authorized device to revoke a session before retrying login.

JWT payloads contain:

```text
access:  sub, sessionId, tokenType=access, exp
refresh: sub, sessionId, tokenType=refresh, jti, exp
```

The configured access-token TTL is short (`JWT_ACCESS_TTL_SECONDS`, currently
900 seconds). The session inactivity window is longer
(`SESSION_INACTIVITY_TTL_SECONDS`, currently 31,536,000 seconds).

## Session model

Each device login creates an independent `Session`. Important fields include:

```text
id
userId
hashedRefreshToken
expiresAt
revokedAt
lastActiveAt
createdAt
updatedAt
sessionName
deviceModelIdentifier
deviceModel
platform
osVersion
appVersion
userAgent
ipAddress
locationCountryCode
locationCity
```

`sessionName` is nullable and user-assigned after login. It is separate from
the technical device model. `PATCH /auth/sessions/:sessionId` accepts `null` to
remove the label; empty strings are rejected. Renaming or clearing any session
requires the current session to be older than the fresh-session management
cooldown.

`GET /auth/sessions` returns only the authenticated user's unexpired,
non-revoked sessions. It explicitly selects public fields, orders by
`lastActiveAt` descending, and marks the session referenced by the caller's
access token as `current: true`. It also reports whether the current session is
old enough to manage sessions and when that capability becomes available.
Refresh hashes are never selected or returned.

The public device object keeps the technical and display values separate:

```json
{
  "modelIdentifier": "iPhone17,1",
  "model": "iPhone 16 Pro",
  "platform": "IOS",
  "osVersion": "18.6"
}
```

Both model fields are nullable. Sessions created by older clients return a
`null` model identifier without changing their existing display snapshot.

`DELETE /auth/sessions/:sessionId` revokes an owned active session. A session
may revoke itself immediately. Revoking any other session requires the current
session to be at least `SESSION_MANAGEMENT_COOLDOWN_SECONDS` old (currently 86,400
seconds). Once the cooldown passes, the current session may revoke any other
owned active session regardless of relative age. This prevents a newly created
session from immediately removing established sessions without permanently
privileging old devices.

## Device model normalization

The mobile client owns the mapping from a platform technical identifier to a
display name. For example, the iOS client can map `iPhone17,1` to
`iPhone 16 Pro` and send both values:

```text
X-Device-Model-Identifier: iPhone17,1
X-Device-Model: iPhone 16 Pro
```

The backend does not contain or download a device catalog and does not verify
that the client-supplied display name matches the identifier. This avoids a
backend release when a new phone appears. An unknown identifier is preserved;
the display name may be a generic client fallback or may be absent.

`deviceModelIdentifier` and `deviceModel` are immutable snapshots created with
the session. Refresh, access requests, and session naming do not update them.
`sessionName` remains a separate user-assigned label for one session and is
never inferred from either device field.

Older clients may continue sending only `X-Device-Model`. New clients should
send `X-Device-Model-Identifier` in addition to the existing display header on
password login and email verification. Neither value is a trusted-device
credential or proof of possession.

## Access authorization

`AccessTokenGuard`:

```text
extract Bearer token
→ verify access signature and payload shape
→ require tokenType=access
→ SessionAuthorizationService.assertActive(userId, sessionId)
→ attach payload to request.user
```

The session query requires:

```text
matching id and userId
revokedAt = null
expiresAt > now
user.status = ACTIVE
```

This makes revocation effective immediately for protected endpoints rather
than waiting for the access JWT to expire.

## Refresh rotation

Refresh flow:

```text
verify refresh JWT
→ find matching active session
→ verify user is ACTIVE
→ hash incoming refresh token
→ compare with stored hash
→ calculate next inactivity deadline
→ generate next access and refresh JWTs
→ conditionally update the matching old hash
```

The final `updateMany` includes the old refresh hash, ownership, status,
revocation, and expiration conditions. Only one concurrent request can rotate
the same refresh token successfully. A successful refresh updates:

```text
hashedRefreshToken
expiresAt
lastActiveAt
```

The refresh JWT receives the exact same absolute expiration as the database
session. Refreshing slides the inactivity window forward; ordinary access
requests do not.

## Logout and revocation

Current logout sets `revokedAt` on the caller's current session. Because the
access guard checks the database, both its access and refresh tokens become
unusable immediately.

`DELETE /auth/sessions/others` atomically revokes every other owned active
session while preserving the caller's current session. The operation requires
the current session to be older than the management cooldown and returns the
number of sessions revoked. Repeating it when no other active sessions remain
is successful and returns zero.

## Authenticated password change

`PATCH /account/password` requires an active access-token session and the
current password. The service verifies that the new password is different and
performs the following database changes in one transaction:

```text
conditionally replace the current password hash
→ preserve the caller's current session
→ revoke every other active session
→ record PASSWORD_CHANGED with the current-session snapshot
```

The conditional update includes the previously read password hash so two
concurrent changes cannot both succeed. After the transaction commits, the
service attempts a best-effort password-change email from the immutable
`PASSWORD_CHANGED` event snapshot. Delivery failure does not roll back the
password change or session revocations.

## Password recovery

`POST /auth/forgot-password` returns the same accepted response for eligible,
unknown, pending, blocked, and deleted accounts while within the request
limits. IP- or email-limit exhaustion returns the same
`RATE_LIMIT_EXCEEDED` response before account lookup, including
`retryAfterSeconds` and a `Retry-After` header. Both fixed-window limits are
database-backed and their email/IP inputs are protected by a configured HMAC
secret.

An eligible active, verified user receives a 256-bit opaque reset token with a
configurable 30-minute default lifetime. Only its SHA-256 hash is stored in a
dedicated `PasswordResetToken`. A new token invalidates prior active tokens.
Email delivery occurs after commit and is retained independently; delivery
failure does not reveal whether the account exists.

`POST /auth/reset-password` conditionally consumes one valid token. Token
consumption, conditional password replacement, invalidation of all remaining
reset tokens, revocation of every active session, and recording
`PASSWORD_RESET_COMPLETED` occur in one transaction. Invalid, expired, used,
superseded, and account-ineligible tokens all return
`PASSWORD_RESET_TOKEN_INVALID`. Every old access and refresh token is then
unusable, and the user signs in normally with the new password.

## Security events

Security events are internal, append-only records. There is no public security
activity endpoint yet, and recording an event does not send an email or push
notification. The current catalog is:

```text
LOGIN_SUCCEEDED
LOGIN_FAILED
SESSION_CREATED
SESSION_CREATION_FAILED
SESSION_REVOKED
OTHER_SESSIONS_REVOKED
SUSPICIOUS_ACTIVITY_DETECTED
PASSWORD_CHANGED
PASSWORD_RESET_REQUESTED
PASSWORD_RESET_COMPLETED
```

`LOGIN_FAILED` means only that the submitted email or password was invalid.
Unknown emails and incorrect passwords have the same public response and event
reason. An unknown email produces an event without a user relation. Pending,
blocked, and deleted account states are not classified as invalid credentials.

`SESSION_CREATION_FAILED` currently means only that the active-session limit
was reached after successful authentication. A normal password login records
`LOGIN_SUCCEEDED` followed by either `SESSION_CREATED` or
`SESSION_CREATION_FAILED`. Email verification records `SESSION_CREATED` when it
creates the first session, but it is not classified as a password login.

Session creation and revocation events are written in the same database
transaction as their corresponding session mutation. A failed mutation does
not leave a success event. `OTHER_SESSIONS_REVOKED` records the number of
sessions affected, including zero for a successful idempotent request.

Events contain bounded request or session snapshots such as the technical
device identifier, display model, IP, and approximate GeoIP location. They
never contain credentials or raw or hashed security tokens. User and session
relations are nullable so retained events can survive deletion of operational
records.

Each event receives a retention deadline based on
`SECURITY_EVENT_RETENTION_SECONDS`, currently 180 days. The security-event
service owns deletion of expired records; production scheduling remains a
deployment concern so multiple application replicas do not run an
uncoordinated cleanup loop.

## New-session notifications

Every committed `SESSION_CREATED` flow attempts one new-session email. Password
login and the first session created after email verification use the same
notification path. `LOGIN_SUCCEEDED` does not trigger a separate email.

Notification delivery happens only after the session transaction commits. A
mail provider, delivery-record, or delivery-status failure never rolls back the
session, revokes tokens, or changes a successful auth response. The initial
implementation makes one immediate best-effort provider attempt; automatic
retry scheduling is not part of Stage 3.

`NotificationDelivery` records `PENDING`, `SENT`, or `FAILED` independently of
the auth response. An explicit unique delivery idempotency key and the Resend
idempotency key prevent an application retry from intentionally creating
duplicate emails. Session notifications use their session ID; password-change
notifications use their security-event ID, allowing multiple legitimate
password changes from the same session. Delivery records retain the recipient
snapshot, provider message ID on success, and a normalized failure code on
failure. Provider error bodies and stack traces are not persisted.

The email contains UTC time, the display model and platform, and approximate
country/city when available. The technical model identifier is retained for
session and security analysis but is not included in the email. Notifications
do not contain IP address, user agent, credentials, or tokens. Plain text is
used so spoofable device metadata cannot be interpreted as HTML.

Delivery records receive a configurable 180-day retention deadline through
`NOTIFICATION_DELIVERY_RETENTION_SECONDS`. As with security events, cleanup
scheduling remains a deployment concern.

## Password-change notifications

Every committed `PASSWORD_CHANGED` event attempts one email to the account's
primary college address. The email uses the event's UTC time, device/platform,
approximate location, and affected-session count. It never contains an IP
address, user agent, password, or token.

The event is created inside the password-change transaction. Its ID is passed
to `NotificationService` only after commit, so mail and delivery-record writes
remain outside the transaction. A missing event, duplicate delivery, database
failure, or mail-provider failure cannot turn a successful password change
into an API error.

## Suspicious-activity analysis

`RiskAnalysisService` evaluates new sessions inside the same serializable
transaction that enforces the active-session limit. It produces an explainable
nullable risk level and an ordered list of contributing signals. A null level
means that no signal was detected; `LOW` is not used as the default.

The implemented signals are:

```text
NEW_DEVICE
NEW_COUNTRY
EXCESSIVE_LOGIN_FAILURES
MANY_NEW_SESSIONS
REFRESH_TOKEN_REUSE
```

The first session does not produce new-device or new-country signals. Missing
or `UNKNOWN` device metadata and unavailable GeoIP do not produce signals.
For new clients, `NEW_DEVICE` primarily compares platform and technical model
identifier. Display-only clients retain the previous platform-and-model
comparison. During the first legacy-to-identifier transition, a matching
legacy display snapshot prevents a false signal. Once identifier-bearing
history exists for that platform and display model, a different identifier is
treated as a new device even when the display names match. Device metadata and
GeoIP remain spoofable or approximate context and are never treated as
security proof.

`EXCESSIVE_LOGIN_FAILURES` currently means at least five user-linked rejected
credential attempts in 15 minutes. `MANY_NEW_SESSIONS` means at least three
sessions, including the current session, in one hour. These thresholds are
validated environment configuration.

One new device or country is `LOW`. Both together, excessive failures, or
session velocity are `MEDIUM`. Two behavioral signals or refresh-token reuse
are `HIGH`. `SESSION_CREATED` stores every detected assessment. `MEDIUM` and
`HIGH` session assessments also atomically create
`SUSPICIOUS_ACTIVITY_DETECTED`.

A valid refresh JWT whose hash no longer matches an otherwise active session is
treated as refresh-token reuse. This includes a losing concurrent refresh after
another request completes rotation. It creates a `HIGH` suspicious-activity
event and a best-effort alert, but does not automatically revoke the session or
block the account.

Risk levels currently influence records and notification wording only. They do
not reject login, revoke sessions, block users, or require step-up
authentication. `IMPOSSIBLE_TRAVEL` is deferred because country/city snapshots
cannot establish physical travel. `LOGIN_AFTER_PASSWORD_CHANGE` is deferred
until password-change events exist.

## GeoIP

GeoIP is optional and best-effort:

```text
request.ip
→ normalize public IPv4/IPv6
→ reject loopback/private/reserved ranges
→ local GeoLite2 City lookup
→ save countryCode and nullable city snapshot
```

The official `ghcr.io/maxmind/geoipupdate` container downloads
`GeoLite2-City.mmdb` into `data/geoip`. The file is ignored by Git and the
Docker build context. Locally:

```bash
npm run geoip:update
npm run geoip:lookup -- 8.8.8.8
```

`GeoIpService` polls the database fingerprint at
`GEOIP_RELOAD_INTERVAL_SECONDS`. A changed file is read into a candidate reader
and validated before the active reader reference is replaced. If the file is
missing or invalid, login continues and either the previous reader remains
active or location resolves to `null`.

Local Postman requests normally use `127.0.0.1` or `::1`, so `location: null`
is expected. End-to-end real-IP behavior must be tested behind the actual
staging proxy/CDN.

## Current error handling

Nest exceptions are used consistently, and some flows already expose structured
codes such as `EMAIL_NOT_VERIFIED` and `ACCOUNT_UNAVAILABLE`. A unified public
error DTO and complete stable error-code catalog are not implemented yet.
Frontend code must not be finalized against message strings before that work is
complete.

Session management documents its current response schemas in Swagger,
including `SESSION_TOO_FRESH`, `SESSION_NOT_FOUND`, and
`SESSION_LIMIT_REACHED`, plus the standard Nest validation and authorization
responses. Structured session errors currently match their actual wire format
and do not yet use the future shared error envelope.

## Current testing boundary

Unit tests cover DTO-adjacent utilities, guards, JWT/session behavior, GeoIP IP
normalization, degraded behavior, and MMDB hot reload. Lightweight e2e tests
cover global validation and HTTP metadata normalization with a replaced
`AuthService`. A separate database-backed suite exercises real session HTTP
routes, JWT guards, services, Prisma queries, PostgreSQL revocation, cooldown,
the active-session limit, and concurrent login behavior.

`npm run test:e2e` prepares a dedicated PostgreSQL database from
`TEST_DATABASE_URL`, defaulting to local `unicon_test`, applies migrations, and
then runs both suites. Database preparation and destructive cleanup refuse to
operate unless the database name ends with `_test`.

## Known production work

- Configure the real reverse-proxy topology and restrict direct origin access.
- Trust only known proxy hops or networks; do not accept arbitrary forwarded IP
  headers.
- Give MaxMind credentials only to the updater container via production
  secrets and mount MMDB read-only into backend containers.
- Schedule official database updates and monitor database age/reload failures.
- Add rate limits, security headers, CORS policy, secret management, and
  security-event observability.
