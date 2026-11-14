import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  migrationManifest,
  verifyMigrationHistory,
  withTemporaryDatabase,
  withLoadDatabase,
  withTestTemplate,
} from '../test-database.mjs';
import {
  repositoryRoot,
  testClient,
  testEnvironment,
  testTarget,
  TestRun,
  withTestWorkdir,
  withTestDatabase,
} from '../test-runtime.mjs';

const base = testTarget('e2e', process.env.TEST_DATABASE_URL);
const recordPath = (target) =>
  join(repositoryRoot, `.temp/${target.kind}-runs`, `${target.runId}.json`);

test('retained load state survives failed and subsequent invocations on the same database', async () => {
  const base = testTarget('load');
  const run = new TestRun();
  const table = `__lifecycle_${process.pid}_${Date.now()}`;
  let created = false,
    firstId,
    firstOid;
  try {
    await withTestWorkdir(async (directory) => {
      await assert.rejects(
        withLoadDatabase(base, run, directory, 'retained', async (target) => {
          firstId = target.runId;
          assert.equal(testEnvironment(target).LOAD_DATABASE_STATE, 'retained');
          await queryTarget(target, async (client) => {
            firstOid = (
              await client.query(
                'SELECT oid FROM pg_database WHERE datname=current_database()',
              )
            ).rows[0].oid;
            await client.query(`CREATE TABLE "${table}" (value text)`);
            created = true;
            await client.query(
              `INSERT INTO "${table}" VALUES ('retained canary')`,
            );
          });
          throw new Error('Synthetic failed retained run.');
        }),
        /Synthetic failed retained run/,
      );
      await withLoadDatabase(
        base,
        run,
        directory,
        'retained',
        async (target) => {
          assert.notEqual(target.runId, firstId);
          assert.equal(target.database, 'unicon_load_test');
          await queryTarget(target, async (client) => {
            assert.equal(
              (
                await client.query(
                  'SELECT oid FROM pg_database WHERE datname=current_database()',
                )
              ).rows[0].oid,
              firstOid,
            );
            assert.equal(
              (await client.query(`SELECT value FROM "${table}"`)).rows[0]
                .value,
              'retained canary',
            );
          });
        },
      );
    });
  } finally {
    if (created)
      await queryTarget(base, (client) =>
        client.query(`DROP TABLE "${table}"`),
      );
    run.dispose();
  }
});

async function queryTarget(target, action) {
  const client = testClient(target);
  client.on('error', () => {});
  try {
    await client.connect();
    return await action(client);
  } finally {
    await client.end();
  }
}

async function assertRemoved(target) {
  const admin = testClient(base, 'postgres');
  try {
    await admin.connect();
    assert.equal(
      (
        await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
          target.database,
        ])
      ).rowCount,
      0,
    );
    assert.equal(existsSync(recordPath(target)), false);
  } finally {
    await admin.end();
  }
}

for (const kind of ['e2e', 'load'])
  test(`real ${kind} clones isolate data, preserve the template and are deleted after success`, async () => {
    const base = testTarget(kind);
    const run = new TestRun();
    let first, second;
    try {
      await withTestWorkdir(async (directory) => {
        await withTemporaryDatabase(base, run, directory, async (target) => {
          first = target;
          const record = JSON.parse(await readFile(recordPath(target), 'utf8'));
          assert.equal(record.database, target.database);
          assert.ok(record.oid);
          assert.equal(record.runId, target.runId);
          await queryTarget(target, async (client) => {
            const manifest = await migrationManifest();
            const { rows } = await client.query(
              'SELECT * FROM "_prisma_migrations"',
            );
            verifyMigrationHistory(manifest, rows, true);
            assert.equal(
              (await client.query('SELECT 1 FROM "User" LIMIT 1')).rowCount,
              0,
            );
            await client.query('CREATE TABLE "__e2e_canary" (value text)');
            await client.query(
              'INSERT INTO "__e2e_canary" VALUES (\'first run only\')',
            );
          });
        });
        await assertRemoved(first);
        await withTemporaryDatabase(base, run, directory, async (target) => {
          second = target;
          assert.notEqual(target.database, first.database);
          await queryTarget(target, async (client) => {
            assert.equal(
              (
                await client.query(
                  "SELECT to_regclass('public.__e2e_canary') AS found",
                )
              ).rows[0].found,
              null,
            );
          });
        });
        await assertRemoved(second);
        await withTestTemplate(
          base,
          run,
          directory,
          async (admin, template) => {
            const state = (
              await admin.query(
                'SELECT datallowconn FROM pg_database WHERE datname=$1',
                [template.database],
              )
            ).rows[0];
            assert.equal(state.datallowconn, false);
            await assert.rejects(
              queryTarget(template, async () => {}),
              /not currently accepting connections/,
            );
          },
        );
      });
    } finally {
      run.dispose();
    }
  });

test('real template rejects changed/foreign/failed migrations and dirty singleton state before cloning', async () => {
  const run = new TestRun();
  const template = testTarget('template');
  async function editTemplate(action) {
    return withTestDatabase(template, run, async ({ client }) => {
      await client.query(
        'ALTER DATABASE "unicon_e2e_template" ALLOW_CONNECTIONS true',
      );
      try {
        return await queryTarget(template, action);
      } finally {
        await client.query(
          'ALTER DATABASE "unicon_e2e_template" ALLOW_CONNECTIONS false',
        );
      }
    });
  }
  try {
    await withTestWorkdir(async (directory) => {
      await withTestTemplate(base, run, directory, async () => {});
      const original = await editTemplate(
        async (client) =>
          (
            await client.query(
              'SELECT *, finished_at::text AS finished_at FROM "_prisma_migrations" ORDER BY migration_name LIMIT 1',
            )
          ).rows[0],
      );
      for (const scenario of ['checksum', 'foreign', 'failed', 'dirty']) {
        try {
          await editTemplate(async (client) => {
            if (scenario === 'checksum')
              await client.query(
                'UPDATE "_prisma_migrations" SET checksum=$1 WHERE id=$2',
                ['0'.repeat(64), original.id],
              );
            if (scenario === 'foreign')
              await client.query(
                'UPDATE "_prisma_migrations" SET migration_name=$1 WHERE id=$2',
                ['99999999999999_foreign_branch', original.id],
              );
            if (scenario === 'failed')
              await client.query(
                'UPDATE "_prisma_migrations" SET finished_at=NULL WHERE id=$1',
                [original.id],
              );
            if (scenario === 'dirty')
              await client.query(
                'UPDATE "MailProviderPressure" SET revision=1 WHERE id=1',
              );
          });
          await assert.rejects(
            withTemporaryDatabase(base, run, directory, () =>
              assert.fail('Unsafe template was cloned.'),
            ),
            /manual review is required/,
          );
        } finally {
          // Restore exactly the metadata/state changed by this fault-injection test.
          await editTemplate(async (client) => {
            await client.query(
              'UPDATE "_prisma_migrations" SET migration_name=$1, checksum=$2, finished_at=$3 WHERE id=$4',
              [
                original.migration_name,
                original.checksum,
                original.finished_at,
                original.id,
              ],
            );
            if (scenario === 'dirty')
              await client.query(
                'UPDATE "MailProviderPressure" SET revision=0 WHERE id=1',
              );
          });
        }
      }
      await withTestTemplate(base, run, directory, async () => {});
    });
  } finally {
    run.dispose();
  }
});

test('real temporary database is removed after a failed child and interruption', async () => {
  for (const kind of ['e2e', 'load'])
    for (const interrupt of [false, true]) {
      const base = testTarget(kind);
      const run = new TestRun();
      let observed;
      try {
        await withTestWorkdir(async (directory) => {
          await assert.rejects(
            withTemporaryDatabase(base, run, directory, async (target) => {
              observed = target;
              if (interrupt) {
                const child = run.command(['-e', 'setInterval(()=>{},1000)'], {
                  cwd: directory,
                  env: testEnvironment(target),
                  stdio: 'ignore',
                });
                await delay(100);
                run.controller.abort(new Error('Synthetic interruption.'));
                await child;
              } else {
                assert.equal(
                  await run.command(['-e', 'process.exit(7)'], {
                    cwd: directory,
                    env: testEnvironment(target),
                    stdio: 'ignore',
                  }),
                  7,
                );
                throw new Error('Synthetic child failure.');
              }
            }),
            interrupt ? /Synthetic interruption/ : /Synthetic child failure/,
          );
        });
        await assertRemoved(observed);
      } finally {
        run.dispose();
      }
    }
});

test('cleanup refuses a database whose ownership marker changed and retains its run record', async () => {
  const run = new TestRun();
  let observed, observedOid;
  const admin = testClient(base, 'postgres');
  try {
    await admin.connect();
    await withTestWorkdir(async (directory) => {
      await assert.rejects(
        withTemporaryDatabase(base, run, directory, async (target) => {
          observed = target;
          observedOid = JSON.parse(
            await readFile(recordPath(target), 'utf8'),
          ).oid;
          await admin.query(
            `COMMENT ON DATABASE "${target.database}" IS 'synthetic foreign marker'`,
          );
        }),
        /Refusing cleanup/,
      );
    });
    assert.ok(existsSync(recordPath(observed)));
    const { rows } = await admin.query(
      'SELECT oid FROM pg_database WHERE datname=$1',
      [observed.database],
    );
    assert.equal(rows[0].oid, observedOid);
  } finally {
    // Deliberate test tampering: remove only this test's verified allocation.
    if (observed && observedOid) {
      const { rows } = await admin.query(
        'SELECT oid FROM pg_database WHERE datname=$1',
        [observed.database],
      );
      assert.equal(rows[0]?.oid, observedOid);
      await admin.query(`DROP DATABASE "${observed.database}"`);
      await rm(recordPath(observed));
    }
    await admin.end();
    run.dispose();
  }
});
