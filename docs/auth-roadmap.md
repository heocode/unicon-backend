# Auth and Profile Roadmap

The goal of this roadmap is a stable backend contract for implementing the
complete mobile auth and profile experience without repeatedly redesigning the
backend. Complete stages in order unless a dependency requires otherwise.

## Definition of frontend-ready

Auth/profile backend is ready for focused frontend integration when:

- registration, verification, login, refresh, logout, recovery, and protected
  profile flows are complete;
- users can inspect, name, and revoke sessions;
- response DTOs and machine-readable error codes are stable;
- Swagger documents every public request, response, error, and device header;
- primary success, authorization, replay, recovery, and revocation flows have
  real integration/e2e coverage;
- TOTP and passkey ceremonies have defined contracts ready for client testing;
- no known breaking auth API redesign is expected.

Passkeys still require a focused frontend/backend integration pass because the
platform authenticator participates in the WebAuthn ceremony.

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
- Structured device metadata and application version snapshots.
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

Implement:

```text
POST /auth/forgot-password
POST /auth/reset-password
```

- Return the same public forgot-password response whether an email exists.
- Store only a reset-token hash with a short expiration.
- Rate-limit requests and prevent token reuse.
- Revoke all sessions after successful reset.
- Emit security events and best-effort notifications.
- Add real e2e coverage proving the old password and old sessions stop working.

## Stage 7: TOTP two-factor authentication

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

## Stage 8: Passkeys

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

Keep three concepts separate:

```text
deviceModelIdentifier: technical identifier such as iPhone17,1
deviceModel: normalized display snapshot such as iPhone 16 Pro
sessionName: optional user-assigned label such as Personal phone
```

Choose whether model mapping is owned by the mobile client, backend, or a shared
generated catalog. Preserve the raw identifier so mappings can improve without
losing source data. Never use the displayed model as a strong security proof.

## Stage 10: Account deletion

Implement a re-authenticated deletion flow with a product-approved grace period
and cancellation path. Current recommendation: 14–30 days.

The design must define:

- immediate revocation of every session;
- `deletionScheduledAt` and account status behavior;
- cancellation rules;
- deletion/anonymization of profile and future user-generated content;
- removal of passkeys, TOTP secrets, recovery codes, and tokens;
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
account state, sessions, refresh replay/expiry, password recovery, 2FA,
passkeys, rate limits, and deletion state.

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
TOTP setup → challenge → recovery code
passkey registration → passkey login → removal
account deletion request → cancellation/completion
security-event and notification side effects
GeoIP degraded mode and MMDB reload
```

## Explicitly excluded

- Google, Apple, or other OAuth login.
- Account creation through passkeys.
- GPS tracking or precise physical location storage.
- GeoIP as the sole reason for automatic account blocking.
- Silent session eviction when the active-session limit is reached.
