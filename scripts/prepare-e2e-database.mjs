import { spawnSync } from 'node:child_process';
import process from 'node:process';
import pg from 'pg';

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/unicon_test';
const parsedUrl = new URL(testDatabaseUrl);
const databaseName = parsedUrl.pathname.slice(1);

if (!databaseName.endsWith('_test')) {
  throw new Error(
    `Refusing to prepare database "${databaseName}" because its name does not end with "_test".`,
  );
}

if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
  throw new Error('The test database name contains unsupported characters.');
}

const adminUrl = new URL(parsedUrl);
adminUrl.pathname = '/postgres';

const client = new pg.Client({ connectionString: adminUrl.toString() });
await client.connect();

try {
  const existingDatabase = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [databaseName],
  );

  if (existingDatabase.rowCount === 0) {
    await client.query(`CREATE DATABASE "${databaseName}"`);
  }
} finally {
  await client.end();
}

const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const migration = spawnSync(npxCommand, ['prisma', 'migrate', 'deploy'], {
  env: {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
  },
  stdio: 'inherit',
});

if (migration.error) {
  throw migration.error;
}

if (migration.status !== 0) {
  process.exit(migration.status ?? 1);
}
