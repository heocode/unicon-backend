import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  e2eRunTarget,
  migrationManifest,
  verifyMigrationHistory,
} from '../e2e-database.mjs';
import { testEnvironment, testTarget } from '../test-runtime.mjs';

test('temporary destination is derived only from a validated endpoint and UUID', () => {
  const runId = randomUUID();
  const target = e2eRunTarget(testTarget('e2e'), runId);
  assert.equal(target.database, `unicon_e2e_${runId.replaceAll('-', '')}_test`);
  assert.equal(new URL(target.url).pathname, `/${target.database}`);
  assert.equal(testEnvironment(target).UNICON_TEST_RUN_ID, runId);
  for (const invalid of [
    'unicon',
    'unicon_test',
    '../unicon',
    `${runId}"`,
    runId.replaceAll('-', ''),
  ])
    assert.throws(() => e2eRunTarget(testTarget('e2e'), invalid));
  assert.throws(() => e2eRunTarget(testTarget('load'), runId));
  assert.throws(() => testTarget('e2e', target.url));
});

test('history accepts only a successful unchanged prefix, requiring all migrations after deploy', () => {
  const manifest = [
    { name: '001', checksum: 'a' },
    { name: '002', checksum: 'b' },
  ];
  const first = {
    migration_name: '001',
    checksum: 'a',
    finished_at: new Date(),
    rolled_back_at: null,
  };
  verifyMigrationHistory(manifest, []);
  verifyMigrationHistory(manifest, [first]);
  verifyMigrationHistory(
    manifest,
    [first, { ...first, migration_name: '002', checksum: 'b' }],
    true,
  );
  assert.throws(() => verifyMigrationHistory(manifest, [first], true));
  for (const invalid of [
    [{ ...first, migration_name: 'foreign' }],
    [{ ...first, checksum: 'modified' }],
    [{ ...first, finished_at: null }],
    [{ ...first, rolled_back_at: new Date() }],
    [{ ...first, migration_name: '002', checksum: 'b' }],
    [first, first],
  ])
    assert.throws(() => verifyMigrationHistory(manifest, invalid));
  assert.throws(() => verifyMigrationHistory([], [first]));
});

test('manifest uses ordered on-disk migrations and SHA-256 SQL checksums', async () => {
  const manifest = await migrationManifest();
  assert.ok(manifest.length > 0);
  assert.deepEqual(
    manifest.map((entry) => entry.name),
    manifest.map((entry) => entry.name).sort(),
  );
  assert.ok(manifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.checksum)));
});
