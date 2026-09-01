# Unicon Backend Development Guide

Read this file before changing the repository. For auth work, also read
`docs/auth-architecture.md` and `docs/auth-roadmap.md`.
For Profile or media work, read `docs/profile-architecture.md`. For moderation
work, also read `docs/moderation-architecture.md`.

## Project conventions

- Keep NestJS controllers thin. Controllers translate HTTP input into service
  calls and must not contain business logic or direct Prisma queries.
- Use focused services for domain behavior. `AuthService` coordinates auth
  flows; challenge, delivery, proof verification, token, session, and GeoIP
  behavior stay in their dedicated services.
- Infrastructure integrations belong in their own modules outside
  `AuthModule` when they are not auth-specific.
- Use constructor injection. Application code must use `ConfigService` rather
  than reading `process.env` directly.
- Use plural category directories: `services`, `guards`, `decorators`, `dtos`,
  `types`, `utils`.
- Keep source code, public API fields, environment names, migrations, logs, and
  error messages in English.
- Preserve the existing import grouping style: framework, platform/runtime,
  generated or external domain types, then internal modules/services/types.

## Input validation and API contracts

- Validate all external request bodies with DTO classes using
  `class-validator`. Normalize user-controlled strings with `class-transformer`
  only where normalization is part of the contract.
- The global `ValidationPipe` enables `transform`, `whitelist`, and
  `forbidNonWhitelisted`. Do not manually repeat guarantees already provided by
  a DTO.
- Validate and normalize headers or request metadata at the HTTP boundary.
  Never trust client-supplied device metadata as a security signal by itself.
- Public endpoints must have explicit response DTOs and Swagger documentation.
- API errors should expose stable machine-readable codes. Do not make clients
  branch on human-readable message text.
- Never expose internal Prisma records directly when they contain security or
  service fields. Select and map only the public fields required by the API.

## Environment configuration

- Declare public examples in `.env.example` and validate application settings
  in `src/config/environment.validation.ts`.
- Durations are positive integer seconds and use a `*_SECONDS` suffix.
- Use `ConfigService#getOrThrow` after startup validation for required runtime
  settings.
- Do not commit `.env`, MaxMind credentials, tokens, private keys, or other
  secrets.
- Optional infrastructure must fail in a degraded mode when the product flow
  does not depend on it. GeoIP failure must never prevent authentication.

## Prisma and database changes

- Every Prisma schema change requires a new migration and regeneration of the
  client with `npx prisma generate`.
- Never edit `src/generated/prisma` manually.
- Follow existing camelCase Prisma field names and plural relation names for
  collections.
- Scope user-owned reads and mutations by `userId` in the database query. Do
  not fetch a record and check ownership only in application memory.
- Prefer conditional `updateMany` for state transitions that must atomically
  verify ownership and current state.
- Use transactions when multiple database mutations must succeed or fail as a
  unit. External network calls cannot be made transactionally; design explicit
  compensation or retry behavior instead.
- Do not silently delete or rewrite user data in a migration. Call out any
  intentional data loss before applying it.

## Auth security invariants

- V1 authentication uses an allowed institutional email, a six-digit OTP, and
  a magic link. Passwords and passkeys are not part of v1.
- One `AuthenticationChallenge` owns one stable OTP and one stable magic-link
  token for its fixed lifetime. A resend creates a new Delivery and must not
  rotate proof, extend expiration, reset failed attempts, or clear lock state.
- Delivery method and proof method are independent concepts. EMAIL delivery
  carries OTP and magic-link proofs in v1; future IN_APP or PUSH delivery must
  not become identity proof by itself.
- Verify OTPs and magic-link tokens only through versioned keyed hashes. Stable
  resend may recover proof only from a separate versioned authenticated-
  encryption envelope owned by the challenge. Never persist or log plaintext
  proof, never copy proof into Delivery rows, and never use a plain digest for
  the six-digit OTP.
- OTP and magic link share one atomic consumption state. Successful use of one
  must make both unusable, and concurrent verification may create at most one
  session.
- A new user is created only after successful institutional-email proof.
  Pending authentication belongs to the challenge rather than a `PENDING`
  user.
- Challenge request, resend, attempt, and verification limits are
  database-backed and applied before account lookup where enumeration
  protection requires it.
- Access and refresh JWTs contain both `sub` (user ID) and `sessionId`.
- Access-token authorization verifies the JWT and checks that the referenced
  session and user are still active.
- Store refresh tokens only as cryptographic hashes. Never persist or log raw
  access, refresh, OTP, magic-link, continuation, recovery, or challenge
  tokens.
- Refresh rotation must remain atomic. A refresh token can be successfully used
  only once.
- Session expiration is a sliding inactivity deadline. Refresh extends the
  database deadline and issues a refresh JWT with the exact same absolute
  expiration.
- Revoked, expired, missing, or blocked sessions must neither access protected
  routes nor refresh tokens.
- A user may operate multiple independent sessions. Revoking one session must
  not revoke unrelated sessions unless the endpoint explicitly requests it.
- The v1 active-session limit is a strict hard limit. Successful proof at the
  limit remains consumed but creates no session, exposes no session list, and
  grants no revocation authority to the new client. Only an already authorized
  device may free a slot before a completely new sign-in attempt.
- `sessionName` is an optional user-assigned label. It is not an operating
  system device name and is never used for security decisions.
- Device model, platform, OS version, app version, user agent, IP, and GeoIP
  location are informational snapshots and may be absent or spoofed.
- GeoIP stores only approximate country code and city. It must not be treated
  as proof of physical presence or as a sole reason to block a login.
- Suspicious-activity detection should initially create events and
  notifications, not automatic account blocking, until false positives are
  understood.
- OAuth is intentionally out of scope. Account creation requires successful
  proof of an email from an active allowed college domain.
- Future password and passkey authenticators must resolve the existing stable
  `User.id` and converge on the credential-neutral session layer. Password, if
  added, is an optional specialized credential rather than a required field on
  `User`.

## GeoIP operational rules

- The official MaxMind `geoipupdate` container owns database downloads. Do not
  add a second custom downloader.
- `data/geoip/GeoLite2-City.mmdb` is runtime data and must remain ignored by Git
  and the Docker build context.
- `GeoIpDatabaseLoader` validates a new database before `GeoIpService` swaps
  readers. On failure, the previous reader remains active.
- File polling must remain non-blocking, non-overlapping, and stopped during
  NestJS module shutdown.
- Do not enable arbitrary proxy trust to make local GeoIP testing convenient.
  Production proxy trust must match the deployed topology and direct access to
  the origin must be restricted.

## Testing and handoff

- Add focused unit tests for new service behavior and failure cases.
- Add e2e coverage when behavior crosses the HTTP validation/guard boundary.
- Do not claim a database-backed flow is covered when the e2e test replaces the
  underlying service with a mock.
- Before handing off a change, run as applicable:

```bash
npm run build
npm run lint -- --no-fix
npm test -- --runInBand
npm run test:e2e -- --runInBand
npx prisma validate
npx prisma migrate status
```

- Preserve unrelated user changes in a dirty worktree. Do not edit generated
  files manually, reset the worktree, or use destructive Git commands.
