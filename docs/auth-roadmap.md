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

Create an append-only security-event model and service before notifications or
risk detection. Candidate event types:

```text
LOGIN_SUCCEEDED
LOGIN_FAILED
NEW_SESSION_CREATED
SESSION_REVOKED
OTHER_SESSIONS_REVOKED
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

Events may snapshot session ID, device information, IP, approximate location,
risk level/signals, and timestamp. Do not store raw credentials or tokens.
Define retention before production; an initial 90–180 day window is reasonable
but remains a product/privacy decision.

## Stage 3: Login notifications

- Introduce a notification abstraction separate from auth orchestration.
- Send a best-effort email after a new session is committed.
- Include time, device model/platform, and approximate location when available.
- Notification failure must not roll back or reject login.
- Prepare the abstraction for mobile push without requiring push in the first
  implementation.
- Record delivery status outside the auth response.

## Stage 4: Suspicious-activity signals

Start with explainable, conservative signals:

```text
NEW_DEVICE
NEW_COUNTRY
EXCESSIVE_LOGIN_FAILURES
MANY_NEW_SESSIONS
IMPOSSIBLE_TRAVEL
REFRESH_TOKEN_REUSE
LOGIN_AFTER_PASSWORD_CHANGE
```

- Produce `LOW`, `MEDIUM`, or `HIGH` risk with recorded contributing signals.
- Initially create security events and notifications only.
- Do not automatically block accounts based solely on GeoIP or a first-version
  risk score.
- Add blocking or step-up authentication only after false positives are measured.

## Stage 5: Profile module

Create a dedicated `ProfileModule`; do not place profile resource queries in
`AuthController`.

Planned surface:

```text
GET   /profile/me
PATCH /profile/me
PATCH /profile/password
```

`GET /profile/me` returns only public account and university data. Never expose
password hashes, token hashes, lockout internals, or deletion/security service
fields.

Password change requires current-password verification, keeps the current
session, revokes other sessions, emits a security event, and sends a best-effort
notification.

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
