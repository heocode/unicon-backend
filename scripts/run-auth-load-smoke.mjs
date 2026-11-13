import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// Deliberately no dotenv: the stand never loads the application's .env.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://unicon_e2e:unicon_e2e_local@localhost:5433/unicon_load_test';
const url = new URL(databaseUrl);
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  url.port !== '5433' ||
  url.pathname !== '/unicon_load_test' ||
  url.username !== 'unicon_e2e' ||
  url.search ||
  url.hash
) {
  throw new Error(
    'Smoke stand requires local unicon_e2e PostgreSQL on port 5433 and database unicon_load_test.',
  );
}
const directory = await mkdtemp(join(tmpdir(), 'unicon-load-'));
const report = join(root, 'load-results', `smoke-${Date.now()}.json`);
// Do not inherit application secrets/configuration into the stand.
const env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  DOTENV_CONFIG_PATH: '/dev/null',
  TEST_DATABASE_URL: databaseUrl,
  DATABASE_URL: databaseUrl,
  LOAD_REPORT_PATH: report,
};
for (const key of [
  'LOAD_RATE',
  'LOAD_DURATION_SECONDS',
  'LOAD_PROVIDER_DELAY_MS',
  'LOAD_DRAIN_SECONDS',
]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
async function run(executable, args, cwd) {
  const code = await new Promise((resolveExit, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) throw new Error('Smoke stand subprocess failed.');
}
let lock;
try {
  await run(
    process.execPath,
    [join(root, 'scripts/prepare-e2e-database.mjs')],
    root,
  );
  lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  const { rows } = await lock.query(
    'SELECT pg_try_advisory_lock(704007001) AS acquired',
  );
  if (!rows[0].acquired) throw new Error('Another smoke stand is running.');
  await mkdir(dirname(report), { recursive: true });
  await symlink(join(root, 'assets'), join(directory, 'assets'));
  console.log(`Smoke report target: ${report}`);
  await run(
    process.execPath,
    [
      '--experimental-vm-modules',
      join(root, 'node_modules/jest/bin/jest.js'),
      '--config',
      join(root, 'test/load/jest-load.json'),
      '--runInBand',
    ],
    directory,
  );
  console.log(`Smoke report: ${report}`);
} finally {
  await lock?.end();
  await rm(directory, { recursive: true, force: true });
}
