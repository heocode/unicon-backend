# Unicon Backend

Backend API for Unicon, a campus community application for verified college
students.

The service is built with NestJS, TypeScript, Prisma, and PostgreSQL. The
approved mobile v1 authentication contract is passwordless: one institutional
email challenge carries a six-digit OTP and a magic link, then converges on
rotating server-side sessions. Profile access, security events, and the
account-deletion lifecycle remain attached to the stable `User.id`.

This branch is migrating from the previous password implementation. The target
contract is defined in the auth documentation and is not complete until its
roadmap stages, migrations, runtime code, and database-backed tests are
delivered. Passwords, passkeys, OAuth, personal recovery email, and in-app
delivery are outside v1.

## Technology

- NestJS 11 and TypeScript
- Prisma 7 with PostgreSQL 17
- JWT access and rotating refresh tokens
- Resend for transactional email
- MaxMind GeoLite2 City for optional, approximate session location
- Swagger/OpenAPI
- Jest, Supertest, and database-backed end-to-end tests
- Docker Compose for local PostgreSQL and GeoIP database updates

## Documentation

- [`AGENTS.md`](AGENTS.md) — repository development and security rules
- [`docs/auth-architecture.md`](docs/auth-architecture.md) — approved
  passwordless challenge, delivery, proof, session, and account architecture
- [`docs/auth-roadmap.md`](docs/auth-roadmap.md) — ordered passwordless
  implementation and verification stages
- [`docs/public-api-contract.md`](docs/public-api-contract.md) — target mobile
  endpoints, response DTOs, error codes, and client requirements
- [`docs/profile-architecture.md`](docs/profile-architecture.md) — accepted
  Onboarding, Profile, Profile Photo, media, storage, and delivery architecture
- [`docs/moderation-architecture.md`](docs/moderation-architecture.md) —
  provider-neutral moderation, `profile-photo-v1` policy, recovery, audit,
  reuse, visibility, and human-review architecture

Read `AGENTS.md` before changing the repository. Auth work must also follow the
three auth documents above. Profile, media, and moderation work must follow
their respective architecture documents.

## Local setup

### Prerequisites

- Node.js and npm
- Docker with Docker Compose
- A Resend API key and an approved sender for real email flows
- MaxMind credentials only when local GeoIP lookup is required

### 1. Install dependencies

```bash
npm install
```

### 2. Configure the environment

```bash
cp .env.example .env
```

Replace every placeholder required by
[`src/config/environment.validation.ts`](src/config/environment.validation.ts).
Generate independent secrets rather than reusing one value:

```bash
openssl rand -hex 32
```

At minimum, configure:

- `DATABASE_URL`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `RESEND_API_KEY`
- `MAIL_FROM`
- `CLIENT_URL`
- the authentication challenge HMAC and rate-limit secrets required by the
  completed passwordless configuration

During the documentation-first migration, the checked-in
`src/config/environment.validation.ts` and `.env.example` remain authoritative
for the still-transitional runtime. Their password-specific settings are
removed when the corresponding roadmap implementation stage lands; do not
invent target environment names before that stage defines and validates them.

Durations use positive integer seconds. Never commit `.env`, API keys, JWT
secrets, rate-limit secrets, credentials, or raw authentication tokens.

### 3. Start PostgreSQL

```bash
docker compose up -d postgres
```

This passwordless workspace exposes its own development PostgreSQL at
`localhost:5434` with the database `unicon_passwordless`. Its container and
volume are separate from the legacy auth workspace on `localhost:5432`. The
example application port is `3001`, so both backends can run simultaneously.

The e2e suite uses a physically separate PostgreSQL 17 container and volume.
Start it only when database-backed tests are needed:

```bash
docker compose --profile test up -d postgres-test
```

It exposes only the disposable `unicon_test` database at `localhost:5433`.
`TEST_DATABASE_URL` in `.env` selects it; never point that setting at the
development database.

### 4. Apply migrations and seed development data

```bash
npx prisma migrate dev
npx prisma db seed
```

The seed is idempotent and creates the current development university and
allowed-domain records. Review [`prisma/seed.ts`](prisma/seed.ts) before using
its data outside local development.

### 5. Start the API

```bash
npm run start:dev
```

With the default configuration:

- API base URL: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/api/docs`

The application validates its environment during startup and exits when a
required setting is absent or malformed.

## Public API contract

Public auth, account, and profile endpoints have explicit success DTOs and
Swagger responses. Every non-2xx JSON response uses the stable envelope:

```json
{
  "code": "AUTH_CHALLENGE_INVALID",
  "message": "The authentication challenge cannot be used."
}
```

Structured context is exposed only when documented:

```json
{
  "code": "RATE_LIMIT_EXCEEDED",
  "message": "Too many requests. Please try again later.",
  "details": {
    "retryAfterSeconds": 60
  }
}
```

Clients must branch on `code`, never on the English `message`. Validation
failures use `VALIDATION_FAILED` with `details.violations`. Rate-limited
responses also include an authoritative `Retry-After` header.

Access and refresh tokens belong to one server-side session. Refresh rotation
is atomic, and a refresh token can be successfully used only once. Raw tokens
and internal Prisma records must never be logged or returned outside their
documented public DTOs.

See [`docs/public-api-contract.md`](docs/public-api-contract.md) for the full
endpoint inventory and stable error-code catalog.

## Project structure

```text
src/
├── account/       Recent-authenticated account-deletion lifecycle
├── auth/          Challenges, deliveries, proof verification, and sessions
├── common/        Shared public HTTP contracts, filters, errors, and utilities
├── config/        Environment validation
├── geo-ip/        Optional local MaxMind lookup and hot reload
├── mail/          Transactional email provider integration
├── notifications/ Security and account notification coordination
├── prisma/        Database service and transaction utilities
├── profile/       Public profile queries and mapping
├── security/      Risk evaluation and security-event behavior
├── swagger/       Focused reusable OpenAPI configuration and decorators
└── generated/     Generated Prisma client; never edit manually

prisma/
├── migrations/    Ordered database migration history
├── schema.prisma  Database schema
└── seed.ts        Idempotent local development seed

test/              HTTP/OpenAPI and real PostgreSQL end-to-end suites
```

Controllers stay thin. Domain behavior belongs in focused services, external
input is validated with DTOs at the HTTP boundary, and public responses are
mapped rather than exposing persistence records directly.

## Testing

### Unit tests

```bash
npm test -- --runInBand
```

### End-to-end tests

```bash
npm run test:e2e -- --runInBand
```

The e2e command loads `.env`, prepares the dedicated test PostgreSQL database,
applies migrations, and runs real HTTP flows through guards, services, and
Prisma. It uses `TEST_DATABASE_URL` when provided, otherwise it defaults to the
separate Compose test service:

```text
postgresql://unicon_e2e:unicon_e2e_local@localhost:5433/unicon_test
```

For safety, preparation and destructive cleanup refuse to operate unless the
database name ends with `_test`. Do not point e2e tests at development,
staging, or production data.

The target suite covers validation and public errors, stable challenge proof
and resend behavior, sessions, refresh rotation and reuse, profile safety,
account deletion, abuse limits, concurrency, and generated OpenAPI structure.

### Full handoff checks

```bash
npm run build
npm run lint -- --no-fix
npm test -- --runInBand
npm run test:e2e -- --runInBand
npx prisma validate
npx prisma migrate status
```

## Database workflow

After changing [`prisma/schema.prisma`](prisma/schema.prisma):

```bash
npx prisma migrate dev --name describe_the_change
npx prisma generate
npx prisma validate
```

Every schema change requires a migration and regenerated client. Never edit
`src/generated/prisma` manually, and never introduce silent data loss in a
migration.

Useful inspection commands:

```bash
npx prisma migrate status
npx prisma studio
```

## Account-deletion finalization

An account-deletion request immediately revokes active sessions and starts the
configured grace period. Cancellation creates a completely new session and
token pair. Expired requests are finalized by a one-shot command intended for
an external scheduler:

```bash
npm run build
npm run account-deletion:finalize
```

The command processes configured batches with database locking, anonymizes
direct identifiers, removes authentication material, and retries completion
notifications without reversing a completed deletion. Operational details are
documented in [`docs/auth-architecture.md`](docs/auth-architecture.md).

## GeoIP

GeoIP is optional and best-effort. Authentication continues when the database
is missing, stale, or cannot be reloaded.

To enable local lookup:

1. Set `MAXMIND_ACCOUNT_ID` and `MAXMIND_LICENSE_KEY` in `.env`.
2. Download the database with the official MaxMind updater:

   ```bash
   npm run geoip:update
   ```

3. Set `GEOIP_ENABLED=true` and keep `GEOIP_DATABASE_PATH` pointed at the
   downloaded database.

The file is stored at `data/geoip/GeoLite2-City.mmdb` and is excluded from Git
and the Docker build context. A new database is validated before the active
reader is swapped; on failure, the previous reader remains active.

Test a local lookup without changing proxy trust:

```bash
npm run geoip:lookup -- 8.8.8.8
```

Client IP and device metadata are informational snapshots and must not be
treated as proof of identity or physical presence.

## Useful commands

| Command                             | Purpose                                          |
| ----------------------------------- | ------------------------------------------------ |
| `npm run start:dev`                 | Start NestJS in watch mode                       |
| `npm run build`                     | Compile the application                          |
| `npm run start:prod`                | Run the compiled application                     |
| `npm run lint -- --no-fix`          | Check lint without modifying files               |
| `npm run format`                    | Format source and tests                          |
| `npm test -- --runInBand`           | Run unit tests serially                          |
| `npm run test:e2e -- --runInBand`   | Prepare the test DB and run all e2e tests        |
| `docker compose --profile test up -d postgres-test` | Start isolated e2e PostgreSQL       |
| `npm run geoip:update`              | Download GeoLite2 City with the official updater |
| `npm run geoip:lookup -- <ip>`      | Inspect a local GeoIP result                     |
| `npm run account-deletion:finalize` | Finalize eligible deletion requests              |
| `docker compose down`               | Stop local Compose services                      |

## Security notes

- Store refresh tokens as hashes. Verify authentication proof through keyed
  hashes; recover stable resend proof only from the challenge's approved
  authenticated-encryption envelope.
- Never log raw access, refresh, OTP, magic-link, continuation, recovery, or
  challenge tokens.
- One challenge owns one stable OTP and magic-link token. Resend creates a new
  Delivery without rotating proof, extending expiry, or resetting attempts.
- OTP and magic link share one atomic single-use state.
- Access authorization checks both the JWT and the referenced session/account
  state.
- Session and device metadata may be missing or spoofed and is not a security
  signal by itself.
- GeoIP failure must never prevent authentication.
- Suspicious activity currently creates events and notifications rather than
  automatically blocking accounts.
- Production proxy trust must match the deployed topology; do not enable
  arbitrary proxy trust for local convenience.

Report security-sensitive findings privately rather than opening an issue that
contains credentials, tokens, personal data, or exploit details.
