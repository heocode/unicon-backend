import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  repositoryRoot,
  testClient,
  testEnvironment,
  testTarget,
  withTestDatabase,
} from './test-runtime.mjs';

const templateMarker = 'unicon.e2e.template.v1';
const registry = join(repositoryRoot, '.temp/e2e-runs');
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function e2eRunTarget(base, runId) {
  base = testTarget('e2e', base.url);
  if (!uuidPattern.test(runId)) throw new Error('Invalid e2e run identifier.');
  const database = `unicon_e2e_${runId.replaceAll('-', '')}_test`;
  const url = new URL(base.url);
  url.pathname = `/${database}`;
  return { kind: 'e2e', database, url: url.toString(), runId };
}

export async function migrationManifest(
  directory = join(repositoryRoot, 'prisma/migrations'),
) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => ({
        name: entry.name,
        checksum: createHash('sha256')
          .update(await readFile(join(directory, entry.name, 'migration.sql')))
          .digest('hex'),
      })),
  );
}

export function verifyMigrationHistory(manifest, history, complete = false) {
  const applied = history
    .slice()
    .sort((a, b) => a.migration_name.localeCompare(b.migration_name));
  if (
    applied.length > manifest.length ||
    (complete && applied.length !== manifest.length)
  )
    throw new Error('Template migration history differs from this checkout.');
  for (let i = 0; i < applied.length; i++) {
    if (
      !applied[i].finished_at ||
      applied[i].rolled_back_at ||
      applied[i].migration_name !== manifest[i].name ||
      applied[i].checksum !== manifest[i].checksum
    )
      throw new Error(
        'Template has failed, changed or foreign migrations; manual review is required.',
      );
  }
}

async function inspectTemplate(target, manifest, complete) {
  const client = testClient(target);
  client.on('error', () => {});
  try {
    await client.connect();
    const { rows: present } = await client.query(
      "SELECT to_regclass('public._prisma_migrations') AS table_name",
    );
    const history = present[0].table_name
      ? (
          await client.query(
            'SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations',
          )
        ).rows
      : [];
    verifyMigrationHistory(manifest, history, complete);
    const { rows: tables } = await client.query(
      "SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
    );
    for (const { schemaname, tablename } of tables) {
      if (schemaname !== 'public')
        throw new Error('Unexpected schema in e2e template.');
      if (tablename === '_prisma_migrations') continue;
      // The only data installed by current migrations: two infrastructure singletons.
      if (tablename === 'AuthenticationDeliveryBacklogState') {
        const { rows } = await client.query(
          'SELECT id FROM "AuthenticationDeliveryBacklogState"',
        );
        if (rows.length === 1 && rows[0].id === 1) continue;
      } else if (tablename === 'MailProviderPressure') {
        const { rows } = await client.query(
          'SELECT * FROM "MailProviderPressure"',
        );
        if (
          rows.length === 1 &&
          rows[0].id === 1 &&
          rows[0].retryNotBeforeMicros === '0' &&
          rows[0].dailyNotBeforeMicros === '0' &&
          !rows[0].monthlyBlocked &&
          rows[0].revision === '0'
        )
          continue;
      } else {
        const identifier = `"${tablename.replaceAll('"', '""')}"`;
        if (
          !(await client.query(`SELECT 1 FROM public.${identifier} LIMIT 1`))
            .rowCount
        )
          continue;
      }
      throw new Error(
        'E2e template contains unexpected data; manual review is required.',
      );
    }
    if (!present[0].table_name && tables.length)
      throw new Error('E2e template has schema without migration history.');
  } finally {
    await client.end();
  }
}

function templateTarget(base) {
  const url = new URL(testTarget('e2e', base.url).url);
  url.pathname = '/unicon_e2e_template';
  return testTarget('template', url.toString());
}

async function prepareTemplate(database, target, run, directory) {
  const { client } = database;
  const manifest = await migrationManifest();
  const { rows } = await client.query(
    "SELECT pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1",
    [target.database],
  );
  if (rows.length) {
    if (rows[0].owner !== 'unicon_e2e' || rows[0].marker !== templateMarker)
      throw new Error(
        'Existing template is not owned by this test infrastructure.',
      );
  } else {
    await client.query(
      'CREATE DATABASE "unicon_e2e_template" TEMPLATE template0',
    );
    await client.query(
      `COMMENT ON DATABASE "unicon_e2e_template" IS '${templateMarker}'`,
    );
  }
  await client.query(
    'ALTER DATABASE "unicon_e2e_template" ALLOW_CONNECTIONS true',
  );
  try {
    await inspectTemplate(target, manifest, false);
    await database.prepare(directory, testEnvironment(target));
    await inspectTemplate(target, manifest, true);
    run.controller.signal.throwIfAborted();
  } finally {
    // Tests never receive an enabled connection destination for the template.
    await client.query(
      'ALTER DATABASE "unicon_e2e_template" ALLOW_CONNECTIONS false',
    );
  }
}

/** Standalone preparation and full runs share the template lock. */
export async function withE2eTemplate(base, run, directory, action) {
  const target = templateTarget(base);
  return withTestDatabase(target, run, async (database) => {
    await prepareTemplate(database, target, run, directory);
    return action(database.client, target);
  });
}

export async function withE2eDatabase(base, run, directory, action) {
  return withE2eTemplate(base, run, directory, async (client, template) => {
    const target = e2eRunTarget(base, randomUUID());
    const marker = `unicon.e2e.run.v1:${target.runId}`;
    const recordPath = join(registry, `${target.runId}.json`);
    const record = {
      version: 1,
      runId: target.runId,
      database: target.database,
      template: template.database,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    };
    await mkdir(registry, { recursive: true });
    await writeFile(recordPath, `${JSON.stringify(record)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    let created = false,
      oid;
    try {
      run.controller.signal.throwIfAborted();
      await client.query(
        `CREATE DATABASE "${target.database}" TEMPLATE "unicon_e2e_template"`,
      );
      created = true;
      await client.query(
        `COMMENT ON DATABASE "${target.database}" IS '${marker}'`,
      );
      oid = (
        await client.query('SELECT oid FROM pg_database WHERE datname=$1', [
          target.database,
        ])
      ).rows[0].oid;
      // The initial record already identifies an interrupted allocation; add its PG identity.
      await writeFile(
        `${recordPath}.tmp`,
        `${JSON.stringify({ ...record, oid })}\n`,
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      await rename(`${recordPath}.tmp`, recordPath);
      run.controller.signal.throwIfAborted();
      console.log(`E2e temporary database: ${target.database}`);
      return await action(target);
    } finally {
      if (created) {
        const { rows } = await client.query(
          "SELECT oid, pg_get_userbyid(datdba) AS owner, shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname=$1",
          [target.database],
        );
        if (
          rows.length !== 1 ||
          rows[0].oid !== oid ||
          rows[0].owner !== 'unicon_e2e' ||
          rows[0].marker !== marker
        )
          throw new Error(
            `Refusing cleanup: temporary database ownership changed. Run record: ${recordPath}`,
          );
        // Do not force-close DB sessions. Allow our stopped subprocesses to disconnect.
        const deadline = Date.now() + 5000;
        for (;;) {
          try {
            await client.query(`DROP DATABASE "${target.database}"`);
            break;
          } catch (error) {
            if (error.code !== '55006' || Date.now() >= deadline)
              throw new Error(
                `Temporary database cleanup failed. Run record: ${recordPath}`,
              );
            await delay(100);
          }
        }
      } else {
        // CREATE may have committed even if its response was lost. Keep the
        // allocation record unless absence is confirmed on the same server.
        const existing = await client.query(
          'SELECT 1 FROM pg_database WHERE datname=$1',
          [target.database],
        );
        if (existing.rowCount)
          throw new Error(
            `Incomplete database allocation. Run record: ${recordPath}`,
          );
      }
      await rm(recordPath);
      await rm(`${recordPath}.tmp`, { force: true });
    }
  });
}
