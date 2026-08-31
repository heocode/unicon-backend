# Auth Architecture

This document describes the implemented auth and session architecture. It is a
statement of current behavior, not the future roadmap. Planned work is tracked
in `auth-roadmap.md`.

## Product identity model

Unicon is restricted to students with an email domain present in
`AllowedDomain` and marked active. Registration creates a `PENDING` user and
sends a verification email. Successful verification activates the account and
creates its first session.

The current database model stores the login email, password hash, and
university relation directly on `User`. This is the implemented MVP model, not
a claim that these fields are the permanent identity of the person. The stable
application identity is `User.id`. User-owned product data must reference that
ID rather than email, username, password credential, or university.

Institutional-email verification currently has two effects that the schema
does not yet model separately:

```text
control of an allowed institutional email
→ evidence of college affiliation at the time of verification
→ creation or activation of an authentication account
```

Long term, institutional email should be treated as affiliation evidence and a
replaceable authentication identifier, not as an immutable personal identity.
College mailboxes may be disabled after graduation or reassigned to another
person. Control of a previously used address must therefore never be sufficient
by itself to recover a historical account after that address has ceased to be
an active authentication method for the original user.

The MVP deliberately keeps password authentication and the current schema.
Passwordless authentication, multiple colleges, personal recovery email,
passkeys, and external identity providers are post-MVP work. New domain models
must nevertheless preserve these migration invariants:

- `User.id` is the permanent owner identity for profiles, friendships,
  messages, posts, clubs, and other user data;
- new user-owned relations must not use email as an ownership key;
- a user may eventually have multiple historical or current college
  affiliations;
- authentication methods must be able to change without changing `User.id`;
- matching email addresses from different identity providers are not proof
  that two credentials belong to the same person;
- a historical institutional address must not automatically authenticate a
  user if the college later reassigns the mailbox;
- sensitive operations should evolve toward recent or step-up authentication
  rather than permanently requiring a current password.

OAuth is intentionally excluded. A third-party identity does not prove control
of an allowed college email and would add account-linking risk without removing
the verification requirement. If OAuth is added later, it must be explicitly
linked to an already authenticated `User.id`; email equality alone is not an
account-linking mechanism.

## Authentication and session boundary

Authentication proves which active `User.id` is acting. Session management
starts only after that proof succeeds:

```text
password today ─────┐
email OTP later ────┼→ authenticated User.id → SessionCreationService
passkey later ──────┘
```

`SessionCreationService`, refresh rotation, access authorization, session
queries, revocation, the active-session limit, device metadata, GeoIP, and
session notifications must remain independent of the credential used to prove
identity. Future authenticators should converge on a credential-neutral result
containing at least the user ID, authentication method, and authentication
time, then use the existing session layer.

`Session.createdAt` is not a general substitute for recent authentication. A
future step-up design must record or issue a purpose-bound proof of when and how
the user most recently re-authenticated.

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
  status. `NotificationDeliveryService` centralizes idempotent delivery
  creation, retention, `SENT`/`FAILED` persistence, and retry claims while
  domain notification services retain event lookup, payload construction, and
  failure policy. `MailModule` remains the Resend infrastructure adapter.
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
POST  /account/deletion
POST  /account/deletion/cancel
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

`POST /auth/register` accepts the normalized institutional email and one
password field:

```json
{
  "email": "student@university.ca",
  "password": "Password123!"
}
```

Passwords require at least eight characters, including at least one lowercase
letter, one uppercase letter, one number, and one special character.

Registration flow:

```text
RegisterDto validation
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

## Account-deletion lifecycle

Stage 10 uses a configurable 30-day grace period. Only an authenticated
`ACTIVE` account may request deletion, and the request requires verification
of the current password. The account then enters `DELETION_SCHEDULED`, every
session (including the caller) is revoked immediately, and outstanding
verification and password-reset credentials are invalidated.

A deletion-scheduled account cannot log in, refresh, access protected routes,
or use password recovery. During the grace period, the user may cancel through
a dedicated password-authenticated flow using the normalized account email and
current password. Successful cancellation atomically restores `ACTIVE`, creates
one completely new session, and returns its new access and refresh tokens. No
previously revoked session or token becomes valid again. Password recovery for
deletion cancellation is intentionally deferred to a separate future stage.

Cancellation attempts are protected before account lookup and password
comparison by independent database-backed fixed-window limits for normalized
email and request IP. Bucket keys contain only HMAC-SHA-256 digests under a
dedicated secret; raw email addresses and IP addresses are not stored in the
rate-limit table. The default window is 15 minutes with limits of 5 attempts
per email and 20 per IP. A rejected request returns the stable
`RATE_LIMIT_EXCEEDED` code, `retryAfterSeconds`, and the matching `Retry-After`
header. Serializable transactions and conflict retries make the limit shared
across backend replicas.

Committed deletion requests and cancellations dispatch best-effort email
notifications through `AccountDeletionNotificationService` after the database
transaction. Each delivery uses the corresponding security-event ID in its
unique idempotency key, retains a recipient snapshot under the standard
notification retention deadline, and records `SENT` or `FAILED`. Provider or
delivery-storage failures never roll back the account transition or replace
its successful HTTP response.

After the deadline, a separately scheduled finalizer changes the account to
the terminal `DELETED` state. Finalization keeps an anonymized `User` tombstone
with the same ID so retained comments, likes, messages, future user-generated
content, and security records can preserve referential integrity without
exposing the former identity. Direct identifiers such as email and username
are replaced with unique system values, authentication and recovery
credentials are removed or made unusable, and the original email becomes
available for a new registration that creates a different user ID and must
complete college-email verification again.

Finalization is implemented as the one-shot
`npm run account-deletion:finalize` command for an external scheduler to run
after the application has been built. It processes eligible users in
configurable batches. Each short serializable transaction selects one user
with `FOR UPDATE SKIP LOCKED`, rechecks the deadline, creates the
`ACCOUNT_DELETED` event and a `PENDING` completion delivery containing the
original recipient, deletes sessions and reset tokens, and replaces direct
identifiers and authentication data. The tombstone email is
`deleted+{userId}@deleted.invalid` and its username is `deleted_{userId}`.
Multiple command instances may run safely because locked users are skipped and
the terminal transition is conditional.

The completion email is sent only after commit. A conditional update of the
delivery attempt timestamp claims a `PENDING` or cooldown-eligible `FAILED`
delivery, so parallel workers cannot send it simultaneously. A later command
run retries old completion deliveries with the same provider idempotency key.
Provider failure never reverses `DELETED`. The retry cooldown is configured by
`ACCOUNT_DELETION_COMPLETION_RETRY_SECONDS` and defaults to five minutes.

Security events and notification-delivery records remain only until their
configured retention deadlines. No future user-owned relation may receive a
destructive deletion cascade until its product ownership, presentation, and
retention policy is explicitly defined. TOTP and passkey behavior remains out
of scope while those features are deferred post-MVP.

## Current error handling

All public non-2xx JSON responses use the shared `{ code, message, details? }`
envelope. A global exception filter maps framework exceptions, guarded auth
failures, and unexpected errors to the stable catalog; the global validation
pipe maps DTO violations to `VALIDATION_FAILED` with field-level violations.
Clients branch on `code`, never on the safe English fallback `message`.

The implemented Stage 11 contract is defined in `public-api-contract.md`.
Controllers document explicit success DTOs, named access- or refresh-token
bearer authentication, mobile metadata headers, and endpoint-specific error
statuses and codes. The generated OpenAPI document is covered by a focused
contract test so response schemas and authentication requirements cannot drift
silently.

## Current testing boundary

Unit tests cover DTO-adjacent utilities, guards, JWT/session behavior, GeoIP IP
normalization, degraded behavior, and MMDB hot reload. Lightweight e2e tests
cover global validation, the stable public error envelope, malformed tokens,
and HTTP metadata normalization with a replaced `AuthService`. Separate
database-backed suites exercise real auth, account, and profile HTTP routes,
JWT guards, services, Prisma queries, PostgreSQL state transitions, refresh
rotation, rate limits, and concurrent behavior. Shared contract assertions
verify exact representative success shapes, empty 204 responses, and the
absence of internal persistence and security fields.

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
