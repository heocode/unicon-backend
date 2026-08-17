# Auth and Profile Roadmap

The goal of this roadmap is a stable backend contract for implementing the
mobile auth and profile experience without repeatedly redesigning the backend.
Complete active stages in order unless a dependency requires otherwise. Stages
7 and 8 are retained as post-MVP reference work and do not block product
development or frontend readiness.

## Definition of frontend-ready

Auth/profile backend is ready for focused frontend integration when:

- registration, verification, login, refresh, logout, recovery, and protected
  profile flows are complete;
- users can inspect, name, and revoke sessions;
- response DTOs and machine-readable error codes are stable;
- Swagger documents every public request, response, error, and device header;
- primary success, authorization, replay, recovery, and revocation flows have
  real integration/e2e coverage;
- no known breaking auth API redesign is expected.

TOTP and passkeys are not required for the first product version. If either is
prioritized later, its backend and mobile contracts must be designed and tested
as a separate post-MVP project before implementation is considered complete.

## Completed foundation

- Global strict `ValidationPipe` shared by application and e2e bootstrap.
- Validated environment configuration through `ConfigService`.
- TTL configuration expressed in integer seconds.
- College-domain restricted registration and email verification.
- Short access JWT and long sliding session inactivity window.
- Session-backed access authorization.
- Hashed refresh-token storage and atomic one-time rotation.
- Immediate access denial for revoked, expired, missing, or blocked sessions.
- Multiple independent device sessions.
- Structured technical device identifiers, display model snapshots, and
  application version snapshots.
- Active-session listing with `current` marker.
- Optional user-assigned session names.
- Approximate country/city GeoIP snapshots.
- Official MaxMind `geoipupdate` Docker workflow.
- Non-blocking MMDB polling and atomic hot reload with last-known-good fallback.
- Append-only security-event storage for login and session lifecycle events.
- Atomic security-event recording for session creation and revocation.
- A 180-day configurable security-event retention deadline and cleanup
  primitive.

## Stage 1: Finish session management

- `DELETE /auth/sessions/:sessionId` revokes an owned active session.
- The current session can revoke itself immediately; revoking another session
  requires the configurable fresh-session cooldown to have elapsed.
- `DELETE /auth/sessions/others` atomically revokes every active session except
  the current one after the fresh-session management cooldown.
- `sessionName: null` removes a custom label. Renaming or clearing any session
  requires the fresh-session management cooldown to have elapsed.
- Session response DTOs, stable session error codes, Swagger schemas, unit
  tests, and database-backed session-management e2e tests are implemented.
- The configurable active-session limit is 10. Session creation enforces it in
  a serializable transaction so concurrent logins cannot exceed the limit.
- On limit reached, `SESSION_LIMIT_REACHED` is returned and no existing session
  is silently revoked. A separate verified recovery flow remains planned for a
  user who no longer has access to any authorized device.

## Stage 2: Security-event foundation

Implemented for the current login and session flows. The active event catalog
is intentionally limited to:

```text
LOGIN_SUCCEEDED
LOGIN_FAILED
SESSION_CREATED
SESSION_CREATION_FAILED
SESSION_REVOKED
OTHER_SESSIONS_REVOKED
```

The append-only model and service are in place before notifications or risk
detection. Events snapshot bounded device, IP, and approximate location data,
never credentials or tokens. Retention is configured for 180 days.

Future event types will be added with the flows that define their exact
semantics. The planned catalog currently includes:

```text
PASSWORD_CHANGED
PASSWORD_RESET_REQUESTED
PASSWORD_RESET_COMPLETED
TWO_FACTOR_ENABLED
TWO_FACTOR_DISABLED
TWO_FACTOR_FAILED
PASSKEY_ADDED
PASSKEY_REMOVED
SUSPICIOUS_LOGIN_DETECTED
ACCOUNT_DELETION_REQUESTED
ACCOUNT_DELETION_CANCELLED
ACCOUNT_DELETED
```

Risk levels and signals remain part of Stage 4 rather than the Stage 2 storage
contract.

## Stage 3: Login notifications

Implemented:

- `NotificationModule` is separate from auth orchestration and the Resend mail
  adapter.
- A best-effort email is attempted only after a new session is committed.
- The email includes UTC time, device model/platform, and approximate location
  when available.
- Notification failure does not roll back or reject login or email
  verification.
- Delivery status is recorded as `PENDING`, `SENT`, or `FAILED` outside the
  auth response and retained for a configurable 180 days.
- The notification type/channel model can add mobile push later without adding
  push infrastructure in this stage.
- Resend receives a stable idempotency key for each delivery. Automatic retry
  scheduling remains future operational work.

## Stage 4: Suspicious-activity signals

Implemented with explainable, conservative signals:

```text
NEW_DEVICE
NEW_COUNTRY
EXCESSIVE_LOGIN_FAILURES
MANY_NEW_SESSIONS
REFRESH_TOKEN_REUSE
```

- New-session assessments are recorded as nullable `LOW`, `MEDIUM`, or `HIGH`
  risk with their contributing signals.
- `MEDIUM` and `HIGH` assessments create
  `SUSPICIOUS_ACTIVITY_DETECTED`; refresh-token reuse is always `HIGH`.
- Risk produces security records and best-effort notifications only. It does
  not automatically block accounts, revoke sessions, or reject login.
- Thresholds for excessive failures and session velocity are validated runtime
  configuration.
- `IMPOSSIBLE_TRAVEL` remains deferred because approximate country/city data
  cannot prove travel. `LOGIN_AFTER_PASSWORD_CHANGE` remains deferred until
  Stage 5 defines the password-change event.
- Blocking or step-up authentication remains deferred until false positives
  are measured.

## Stage 5: Profile and account management

Keep public profile queries in `ProfileModule` and authenticated account
lifecycle operations in `AccountModule`; do not place either in
`AuthController`.

Current surface:

```text
GET   /profile/me
PATCH /account/password
```

`GET /profile/me` returns only public account and university data. Password
hashes, token hashes, lockout internals, and deletion/security service fields
are not exposed. `PATCH /profile/me` is deferred until editable profile fields
are defined; the generated username remains read-only.

Password change requires current-password verification, keeps the current
session, revokes other sessions, and emits a security event atomically. After
commit, a best-effort password-change email is attempted and its independent
delivery status is retained. Stage 5 is complete for the currently defined
profile and account surface.

## Stage 6: Password recovery

Implemented:

```text
POST /auth/forgot-password
POST /auth/reset-password
```

- Forgot-password returns the same accepted response for eligible and unknown
  accounts. Email and IP throttling runs before account lookup and returns the
  same `429` contract with a remaining cooldown for every address.
- Opaque reset tokens are stored only as SHA-256 hashes in dedicated records,
  expire after a configurable short lifetime, and are atomically single-use.
- Database-backed keyed-hash rate limits cover normalized email and IP scopes.
- A successful reset atomically changes the password, invalidates every reset
  token, revokes every session, and records its completion event.
- Request and completion events plus idempotent best-effort email deliveries
  are implemented without storing or logging raw tokens.
- Database-backed e2e coverage proves the old password, access tokens, refresh
  tokens, and consumed reset token stop working. Recovery deliberately creates
  no session until a future deep/universal-link contract is designed.

## Stage 7: TOTP two-factor authentication (deferred post-MVP)

TOTP is not required for the first product version and does not block work on
the application's core functionality, frontend integration, or release. Do not
implement partial TOTP infrastructure or substitute email OTP as a second
factor. Reassess this stage only after product usage, security requirements, or
user demand justify the additional login and account-recovery complexity.

Use authenticator-compatible TOTP as the first second factor. Do not treat email
OTP as an equivalent strong factor.

Planned capabilities:

```text
setup
confirm activation
login challenge
disable with step-up authentication
single-use recovery codes
recovery-code regeneration
```

- Encrypt the TOTP secret at rest.
- Store recovery codes only as hashes.
- Use a short-lived pre-auth token between password and second-factor steps.
- Rate-limit challenges and record failures.
- Define account recovery before enabling mandatory 2FA.

## Stage 8: Passkeys (deferred post-MVP)

Passkeys are not required for the first product version and do not block work
on the application's core functionality, frontend integration, or release.
Reassess this stage after the production web and native application topology is
known and a focused client/backend integration pass can be scheduled.

Passkeys authenticate existing `ACTIVE`, college-email-verified accounts. They
must not create an account or bypass allowed-domain verification.

Planned surface:

```text
POST   /auth/passkeys/register/options
POST   /auth/passkeys/register/verify
POST   /auth/passkeys/login/options
POST   /auth/passkeys/login/verify
GET    /auth/passkeys
DELETE /auth/passkeys/:id
```

Before implementation, decide production RP ID, permitted web origins, native
app association, challenge storage/TTL, credential backup policy, signature
counter behavior, and recovery behavior. Verify the ceremony with real iOS and
Android clients before declaring it complete.

## Stage 9: Device model normalization

Implemented for the current native-client contract:

The implementation keeps three concepts separate:

```text
deviceModelIdentifier: technical identifier such as iPhone17,1
deviceModel: normalized display snapshot such as iPhone 16 Pro
sessionName: optional user-assigned label such as Personal phone
```

- `X-Device-Model-Identifier` carries the optional technical identifier while
  the existing `X-Device-Model` remains the optional display snapshot.
- The mobile client owns identifier-to-display mapping. The backend has no
  device catalog, so new hardware does not require a backend release.
- `Session` and `SecurityEvent` preserve the bounded technical identifier and
  display snapshot independently. Existing display-only data is not rewritten.
- Older clients remain compatible and store a null identifier.
- Session listing exposes nullable `device.modelIdentifier` without changing
  the existing `device.model` field.
- `NEW_DEVICE` uses identifier-first comparison with a constrained legacy
  display fallback during client migration.
- Session naming changes only `sessionName`; it never rewrites device
  snapshots.
- Notifications display the model snapshot and platform, not the technical
  identifier.
- Device metadata remains spoofable and is never authorization, trusted-device,
  automatic revocation, or account-blocking proof.
- Focused unit tests and database-backed e2e tests cover login, email
  verification, legacy clients, unknown identifiers, bounded persistence,
  session listing and naming, risk analysis, and notifications.

A shared generated mobile catalog may be introduced later if iOS and Android
need one source of mapping data. It is not required by the backend contract.

## Stage 10: Account deletion

Implement a re-authenticated deletion flow with a product-approved grace period
and cancellation path. Current recommendation: 14–30 days.

The design must define:

- immediate revocation of every session;
- `deletionScheduledAt` and account status behavior;
- cancellation rules;
- deletion/anonymization of profile and future user-generated content;
- removal of passkeys, TOTP secrets, and recovery codes if those post-MVP
  features have been implemented, plus removal of applicable tokens;
- retention requirements for security events;
- confirmation and completion notifications.

Do not implement a cascade until ownership and retention rules for all future
content models are known.

## Stage 11: Stable public contracts

This work should begin incrementally in earlier stages and finish before
frontend freeze:

- Define response DTOs for every auth/profile endpoint.
- Define a shared error envelope and stable error-code catalog.
- Ensure validation errors follow the same public contract.
- Complete Swagger operation, auth, header, response, and error documentation.
- Consider generating the mobile API client from OpenAPI after the contract is
  stable.
- Remove client dependence on English message strings.

Initial error-code families should cover validation, credentials, verification,
account state, sessions, refresh replay/expiry, password recovery, rate limits,
and deletion state. Add 2FA and passkey families only if their deferred stages
are later activated.

## Stage 12: Production hardening

- Choose the deployment platform, reverse proxy, and/or CDN.
- Restrict direct access to the origin and configure exact trusted proxy hops or
  networks.
- Verify real client IP and GeoIP on staging through Wi-Fi, cellular, and VPN.
- Give MaxMind credentials only to the updater workload through secrets.
- Mount MMDB read-only into backend replicas, schedule updates, and monitor
  database age and reload failures.
- Configure CORS, security headers, rate limits, secret management, structured
  security logs, backups, and recovery procedures.
- Audit dependency vulnerabilities deliberately; do not apply blind breaking
  upgrades.

## Stage 13: Full integration and e2e verification

Required flows include:

```text
register → verify → profile/me
login → refresh rotation → protected request
logout → immediate access denial
list sessions → rename → clear name → revoke selected session
revoke all other sessions
session-limit rejection and recovery
forgot password → reset → old password/session rejection
change password → other-session revocation
account deletion request → cancellation/completion
security-event and notification side effects
GeoIP degraded mode and MMDB reload
```

TOTP and passkey integration flows are required only if their deferred
post-MVP stages are later activated.

## Explicitly excluded

- Google, Apple, or other OAuth login.
- Account creation through passkeys.
- GPS tracking or precise physical location storage.
- GeoIP as the sole reason for automatic account blocking.
- Silent session eviction when the active-session limit is reached.
