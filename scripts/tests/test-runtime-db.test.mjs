import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  repositoryRoot,
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
  withTestDatabase,
} from '../test-runtime.mjs';

test('real PG lock rejects other prepare/full runners and is released after child failure', async () => {
  const target = testTarget('e2e', process.env.TEST_DATABASE_URL);
  const first = new TestRun(),
    second = new TestRun();
  let observedDirectory;
  try {
    await withTestWorkdir(async (directory) => {
      observedDirectory = directory;
      const env = testEnvironment(target);
      await withTestDatabase(target, first, async () => {
        await assert.rejects(
          withTestDatabase(target, second, () =>
            assert.fail('Second owner entered.'),
          ),
          /Another e2e run/,
        );
        // Both public entrypoints must stop before migrations/Jest under the same lock.
        assert.equal(
          await first.command(
            [join(repositoryRoot, 'scripts/prepare-e2e-database.mjs')],
            { cwd: directory, env, stdio: 'ignore' },
          ),
          1,
        );
        assert.equal(
          await first.command([join(repositoryRoot, 'scripts/run-e2e.mjs')], {
            cwd: directory,
            env,
            stdio: 'ignore',
          }),
          1,
        );
      });
      await assert.rejects(
        withTestDatabase(target, first, async () => {
          const code = await first.command(['-e', 'process.exit(7)'], {
            cwd: directory,
            env,
            stdio: 'ignore',
          });
          assert.equal(code, 7);
          throw new Error('Synthetic failed run.');
        }),
        /Synthetic failed run/,
      );
      await withTestDatabase(target, second, async () => {});
    });
  } finally {
    first.dispose();
    second.dispose();
  }
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(observedDirectory), false);
});

test('interruption stops the active child and releases the real PG lock', async () => {
  const target = testTarget('e2e', process.env.TEST_DATABASE_URL);
  const first = new TestRun(),
    second = new TestRun();
  try {
    await withTestWorkdir(async (directory) => {
      await assert.rejects(
        withTestDatabase(target, first, async () => {
          const child = first.command(['-e', 'setInterval(()=>{},1000)'], {
            cwd: directory,
            env: testEnvironment(target),
            stdio: 'ignore',
          });
          await delay(100);
          first.controller.abort(new Error('Synthetic interruption.'));
          await child;
        }),
        /Synthetic interruption/,
      );
      await withTestDatabase(target, second, async () => {});
    });
  } finally {
    first.dispose();
    second.dispose();
  }
});
