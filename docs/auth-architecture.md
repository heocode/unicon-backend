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
- `PasswordService` hashes and compares passwords.
- `SecureTokenService` creates and hashes opaque security tokens.
- `JwtTokenService` signs access and refresh JWTs.
- `SessionService` owns session creation, refresh rotation, authorization
  checks, listing, naming, and revocation primitives.
- `EmailVerificationService` owns verification-token lifecycle and activation.
- `AccessTokenGuard` verifies access JWTs and checks the referenced active
  session.
- `RefreshTokenGuard` verifies refresh JWTs and exposes the original token to
  the refresh flow.
- `GeoIpModule` is infrastructure shared with auth. `GeoIpService` resolves a
  public IP through a locally mounted MaxMind MMDB.
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
POST  /auth/refresh
POST  /auth/logout
GET   /auth/sessions
PATCH /auth/sessions/:sessionId
DELETE /auth/sessions/:sessionId
DELETE /auth/sessions/others
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
X-Device-Model
X-Platform
X-OS-Version
X-App-Version
```

Supported platforms are `IOS`, `ANDROID`, `WEB`, and `UNKNOWN`. Client metadata
is informational and can be spoofed.

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

`DELETE /auth/sessions/:sessionId` revokes an owned active session. A session
may revoke itself immediately. Revoking any other session requires the current
session to be at least `SESSION_MANAGEMENT_COOLDOWN_SECONDS` old (currently 86,400
seconds). Once the cooldown passes, the current session may revoke any other
owned active session regardless of relative age. This prevents a newly created
session from immediately removing established sessions without permanently
privileging old devices.

## Access authorization

`AccessTokenGuard`:

```text
extract Bearer token
→ verify access signature and payload shape
→ require tokenType=access
→ SessionService.assertActive(userId, sessionId)
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
