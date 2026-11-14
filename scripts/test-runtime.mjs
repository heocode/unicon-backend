import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const databaseNames = Object.freeze({
  e2e: 'unicon_test',
  load: 'unicon_load_test',
  template: 'unicon_e2e_template',
});

export function testTarget(kind, input) {
  if (!Object.hasOwn(databaseNames, kind))
    throw new Error('Unsupported local test target.');
  const database = databaseNames[kind];
  if (!database) throw new Error('Unsupported local test target.');
  let url;
  try {
    url = new URL(
      input ??
        `postgresql://unicon_e2e:unicon_e2e_local@localhost:5433/${database}`,
    );
    decodeURIComponent(url.password);
  } catch {
    throw new Error('Invalid local test database URL.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.username !== 'unicon_e2e' ||
    !url.password ||
    url.pathname !== `/${database}` ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Local ${kind} tests require unicon_e2e on localhost:5433 and database ${database}, without URL parameters.`,
    );
  }
  return { kind, database, url: url.toString() };
}

export function testEnvironment(target, source = process.env) {
  return {
    PATH: source.PATH,
    TMPDIR: source.TMPDIR ?? tmpdir(),
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: '/dev/null',
    UNICON_TEST_TARGET: target.kind,
    ...(target.runId ? { UNICON_TEST_RUN_ID: target.runId } : {}),
    TEST_DATABASE_URL: target.url,
    DATABASE_URL: target.url,
  };
}

// Use explicit options for admin and target connections; never fall back to PG*.
export function testClient(target, database = target.database) {
  const url = new URL(target.url);
  return new pg.Client({
    host: url.hostname,
    port: 5433,
    user: 'unicon_e2e',
    password: decodeURIComponent(url.password),
    database,
    ssl: false,
    options: '',
    application_name: 'unicon-test-launcher',
    connectionTimeoutMillis: 5000,
  });
}

/** Own only this invocation's processes; abort cleanup never targets PG backends. */
export class TestRun {
  controller = new AbortController();
  handlers = new Map();
  constructor() {
    for (const name of ['SIGINT', 'SIGTERM']) {
      const handler = () =>
        this.controller.abort(new Error(`Test run interrupted by ${name}.`));
      this.handlers.set(name, handler);
      process.on(name, handler);
    }
  }
  dispose() {
    for (const [name, handler] of this.handlers) process.off(name, handler);
  }
  async command(args, { cwd, env, stdio = 'inherit' }) {
    const { signal } = this.controller;
    signal.throwIfAborted();
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio,
      detached: process.platform !== 'win32',
    });
    let killTimer;
    const kill = (name) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(name);
        else process.kill(-child.pid, name);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const abort = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 5000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const code = await new Promise((resolveExit, reject) => {
        child.once('error', () =>
          reject(new Error('Could not start test subprocess.')),
        );
        child.once('close', resolveExit);
      });
      signal.throwIfAborted();
      return code ?? 1;
    } finally {
      signal.removeEventListener('abort', abort);
      kill('SIGKILL');
      clearTimeout(killTimer);
    }
  }
}

export async function withTestWorkdir(run) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'unicon-test-')),
  );
  try {
    await symlink(join(repositoryRoot, 'assets'), join(directory, 'assets'));
    await symlink(join(repositoryRoot, 'prisma'), join(directory, 'prisma'));
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Admin-DB lock precedes CREATE/migrations and spans prepare plus execution. */
export async function withTestDatabase(target, run, action) {
  target = testTarget(target.kind, target.url);
  const client = testClient(target, 'postgres');
  let closing = false;
  const lost = () => {
    if (!closing)
      run.controller.abort(new Error('Test database lock connection lost.'));
  };
  client.on('error', lost);
  client.on('end', lost);
  try {
    try {
      await client.connect();
    } catch {
      throw new Error(
        'Could not connect to the dedicated local test PostgreSQL.',
      );
    }
    const { rows: identity } = await client.query(
      'SELECT current_user AS role',
    );
    if (identity[0]?.role !== 'unicon_e2e')
      throw new Error('Unexpected test database role.');
    const { rows } = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired',
      ['unicon.passwordless.tests.v1', target.database],
    );
    if (!rows[0]?.acquired)
      throw new Error(
        `Another ${target.kind} run or preparation owns this test database.`,
      );
    run.controller.signal.throwIfAborted();
    const result = await action({
      client,
      async prepare(directory, env) {
        run.controller.signal.throwIfAborted();
        if (
          env.DATABASE_URL !== target.url ||
          env.TEST_DATABASE_URL !== target.url ||
          env.UNICON_TEST_TARGET !== target.kind ||
          env.DOTENV_CONFIG_PATH !== '/dev/null'
        )
          throw new Error(
            'Test preparation environment does not match its locked target.',
          );
        const existing = await client.query(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
          [target.database],
        );
        if (existing.rows.length && existing.rows[0].owner !== 'unicon_e2e')
          throw new Error('Unexpected test database owner.');
        if (!existing.rows.length)
          await client.query(`CREATE DATABASE "${target.database}"`);
        const code = await run.command(
          [
            join(repositoryRoot, 'node_modules/prisma/build/index.js'),
            'migrate',
            'deploy',
            '--config',
            join(repositoryRoot, 'prisma.config.ts'),
          ],
          { cwd: directory, env },
        );
        if (code !== 0) throw new Error('Test database migrations failed.');
      },
    });
    run.controller.signal.throwIfAborted();
    return result;
  } finally {
    closing = true;
    await client.end();
  }
}
