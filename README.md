# Unicon Backend

Backend API for Unicon, a campus networking application for students.

## Tech stack

- NestJS and TypeScript
- Prisma ORM and PostgreSQL
- JWT authentication with server-side sessions
- Resend for transactional email
- Jest and Supertest
- Docker

## Project structure

```text
src/
├── auth/       Authentication, email verification and sessions
├── common/     Shared errors and infrastructure types
├── mail/       Transactional email integration
├── prisma/     Prisma service and Nest module
├── swagger/    Reusable OpenAPI decorators
├── app.module.ts
└── main.ts

prisma/
├── migrations/
├── schema.prisma
└── seed.ts

test/
└── app.e2e-spec.ts
```

`src/generated/prisma` is generated from `prisma/schema.prisma` and should not
be edited manually.

## Local setup

Install dependencies:

```bash
npm ci
```

Copy the environment template and provide real credentials:

```bash
cp .env.example .env
```

Start PostgreSQL:

```bash
docker compose up -d
```

Apply migrations, generate Prisma Client and optionally seed development data:

```bash
npx prisma migrate dev
npx prisma generate
npx prisma db seed
```

Start the API in watch mode:

```bash
npm run start:dev
```

The API listens on `http://localhost:3000` by default. Swagger UI is available
at `http://localhost:3000/api/docs`.

## Environment variables

The application validates its environment during startup and fails fast when a
required value is missing or malformed. See `.env.example` for the complete
list.

JWT expiration values must include a unit, for example `15m`, `7d` or `1000ms`.

## Checks

```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

## Production

Build and run locally:

```bash
npm run build
npm run start:prod
```

Build the production container:

```bash
docker build -t unicon-backend .
```

Runtime environment variables must be passed to the container. PostgreSQL in
`docker-compose.yml` is intended for local development.

## Database workflow

Change `prisma/schema.prisma`, create a migration, and regenerate the client:

```bash
npx prisma migrate dev --name describe_change
npx prisma generate
```

Do not edit existing migration files after they have been applied or modify the
generated Prisma Client manually.
