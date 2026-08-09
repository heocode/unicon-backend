Unicon Backend

Backend service for Unicon — a campus networking application for students.

This repository contains the server-side API built with NestJS, TypeScript, Prisma, PostgreSQL, and Docker.

⸻

Tech Stack

- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- Docker & Docker Compose
- Jest

⸻

Project Structure

src/
├── app.controller.ts # HTTP routes
├── app.service.ts # Business logic
├── app.module.ts # Main application module
└── main.ts # Application entry point
prisma/
├── schema.prisma # Database schema
└── migrations/ # Database migration history
test/
└── app.e2e-spec.ts # End-to-end tests

⸻

Getting Started

Install dependencies

npm install

Start PostgreSQL

docker compose up -d

Run database migrations

npx prisma migrate dev

Start the development server

npm run start:dev

The API will be available at:

http://localhost:3000

⸻

Environment Variables

Create a .env file in the project root.

Example:

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/unicon?schema=public"
PORT=3000

⸻

Useful Commands

Start development server

npm run start:dev

Build the project

npm run build

Run tests

npm test

Run E2E tests

npm run test:e2e

Run linter

npm run lint

Open Prisma Studio

npx prisma studio

Update the local GeoLite2 City database

npm run geoip:update

Test the local database without changing proxy trust settings

npm run geoip:lookup -- 8.8.8.8

Stop Docker containers

docker compose down

⸻

GeoIP

Session locations are resolved locally with the MaxMind GeoLite2 City database.
Add MAXMIND_ACCOUNT_ID and MAXMIND_LICENSE_KEY to .env, then run the official
MaxMind geoipupdate container:

npm run geoip:update

The database is stored at data/geoip/GeoLite2-City.mmdb and is intentionally
excluded from Git and the Docker build context. Set GEOIP_ENABLED=false when
the database is not available. Docker is required to update the database, but
the NestJS development server can continue to run directly on the host. GeoIP
lookup is best-effort and never prevents authentication.

The backend checks GEOIP_DATABASE_PATH at the interval configured by
GEOIP_RELOAD_INTERVAL_SECONDS. A new database is validated before the active
reader is replaced; if reload fails, the previous reader remains available.

⸻

Git Workflow

Development is done using feature branches.

Example:

git checkout -b feature/auth

After a feature is completed:

1. Commit your changes.
2. Push the branch.
3. Open a Pull Request into main.
4. Merge after review.
