import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  repositoryRoot,
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
} from '../test-runtime.mjs';

test('target policy rejects wrong role/host/port/database/options before any connection', () => {
  const base =
    'postgresql://unicon_e2e:unicon_e2e_local@localhost:5433/unicon_test';
  for (const input of [
    base.replace('localhost', 'example.com'),
    base.replace('5433', '5432'),
    base.replace('unicon_e2e:', 'postgres:'),
    base.replace('/unicon_test', '/unicon'),
    base.replace('/unicon_test', '/another_test'),
    base.replace('/unicon_test', '/unicon_load_test'),
    `${base}?host=example.com`,
    `${base}#ignored`,
    base.replace(':unicon_e2e_local@', '@'),
    'not-a-url-with-sensitive-content',
  ])
    assert.throws(() => testTarget('e2e', input));
  assert.throws(() => testTarget('constructor'));
  assert.equal(testTarget('e2e').database, 'unicon_test');
  assert.equal(testTarget('load').database, 'unicon_load_test');
  assert.throws(() => testTarget('load', base));
  assert.equal(
    testTarget('e2e', base.replace('localhost', '127.0.0.1')).database,
    'unicon_test',
  );
});

test('allowlist removes inherited application keys, DB settings and Node injection', async () => {
  const target = testTarget('e2e');
  const env = testEnvironment(target, {
    PATH: process.env.PATH,
    JWT_ACCESS_SECRET: 'synthetic-inherited-key',
    RESEND_API_KEY: 'synthetic-inherited-key',
    DATABASE_URL: 'synthetic-production-url',
    PGHOST: 'synthetic-host',
    PGPASSWORD: 'synthetic-password',
    PGOPTIONS: 'synthetic-options',
    NODE_OPTIONS: '--require synthetic-module',
    DOTENV_CONFIG_PATH: 'synthetic.env',
  });
  for (const key of [
    'JWT_ACCESS_SECRET',
    'RESEND_API_KEY',
    'PGHOST',
    'PGPASSWORD',
    'PGOPTIONS',
    'NODE_OPTIONS',
  ])
    assert.equal(env[key], undefined);
  assert.equal(env.DATABASE_URL, target.url);
  assert.equal(env.DOTENV_CONFIG_PATH, '/dev/null');
  const run = new TestRun();
  try {
    await withTestWorkdir(async (directory) => {
      assert.equal(
        await run.command(
          [
            '-e',
            'if(process.env.JWT_ACCESS_SECRET || process.env.RESEND_API_KEY || process.env.NODE_OPTIONS || process.env.PGPASSWORD) process.exit(9)',
          ],
          { cwd: directory, env, stdio: 'ignore' },
        ),
        0,
      );
    });
  } finally {
    run.dispose();
  }
});

test('public launchers reject unsafe targets before preparation without echoing credentials', () => {
  for (const entrypoint of [
    'run-e2e.mjs',
    'prepare-e2e-database.mjs',
    'run-auth-load-smoke.mjs',
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'scripts', entrypoint)],
      {
        env: {
          ...testEnvironment(testTarget('e2e')),
          TEST_DATABASE_URL:
            'postgresql://postgres:synthetic-private-password@example.com:5432/another_test',
        },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /tests require unicon_e2e on localhost:5433/);
    assert.doesNotMatch(result.stderr, /synthetic-private-password/);
  }
});

test('isolated cwd has required resources and is removed even after failure', async () => {
  let created;
  await assert.rejects(
    withTestWorkdir(async (directory) => {
      created = directory;
      assert.notEqual(directory, repositoryRoot);
      assert.equal(existsSync(join(directory, '.env')), false);
      assert.equal(existsSync(join(directory, 'assets')), true);
      assert.equal(existsSync(join(directory, 'prisma/migrations')), true);
      throw new Error('Synthetic test failure.');
    }),
    /Synthetic test failure/,
  );
  assert.equal(existsSync(created), false);
});

test('load CLI rejects unknown or repeated lifecycle flags before connecting', () => {
  for (const args of [
    ['--state=unknown'],
    ['smoke', '--state=unknown'],
    ['smoke', '--state=isolated', '--state=retained'],
    ['smoke', '--config=other'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, 'scripts/run-auth-load-smoke.mjs'), ...args],
      {
        env: testEnvironment(testTarget('load')),
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported auth load stand mode/);
  }
});

test('dotenv in the child cannot read a synthetic caller .env', async () => {
  await withTestWorkdir(async (outer) => {
    await writeFile(
      join(outer, '.env'),
      'UNICON_SYNTHETIC_ENV_CANARY=loaded\n',
    );
    const run = new TestRun();
    try {
      await withTestWorkdir(async (inner) => {
        const code = `require(${JSON.stringify(join(repositoryRoot, 'node_modules/dotenv/config'))}); if(process.env.UNICON_SYNTHETIC_ENV_CANARY) process.exit(9);`;
        assert.equal(
          await run.command(['-e', code], {
            cwd: inner,
            env: testEnvironment(testTarget('e2e')),
            stdio: 'ignore',
          }),
          0,
        );
      });
    } finally {
      run.dispose();
    }
  });
});

test('nonzero child exit is preserved and signal handlers are disposed', async () => {
  const baseline = process.listenerCount('SIGTERM');
  const run = new TestRun();
  try {
    await withTestWorkdir(async (directory) => {
      assert.equal(
        await run.command(['-e', 'process.exit(7)'], {
          cwd: directory,
          env: testEnvironment(testTarget('e2e')),
          stdio: 'ignore',
        }),
        7,
      );
    });
  } finally {
    run.dispose();
  }
  assert.equal(process.listenerCount('SIGTERM'), baseline);
});

test('aborting a run stops its child and removes its working directory', async () => {
  const run = new TestRun();
  let created;
  try {
    await assert.rejects(
      withTestWorkdir(async (directory) => {
        created = directory;
        const task = run.command(['-e', 'setInterval(()=>{},1000)'], {
          cwd: directory,
          env: testEnvironment(testTarget('e2e')),
          stdio: 'ignore',
        });
        await delay(100);
        run.controller.abort(new Error('Synthetic interruption.'));
        await task;
      }),
      /Synthetic interruption/,
    );
    assert.equal(existsSync(created), false);
  } finally {
    run.dispose();
  }
});
