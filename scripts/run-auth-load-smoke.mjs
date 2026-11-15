import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  repositoryRoot as root,
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
} from './test-runtime.mjs';
import { withLoadDatabase } from './test-database.mjs';

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0]?.startsWith('--') ? 'smoke' : (args.shift() ?? 'smoke');
  const stateMode = args.length ? args[0].replace('--state=', '') : 'isolated';
  if (
    ![
      'smoke',
      'concurrency',
      'identity-isolation',
      'shared-ip',
      'mixed-mail',
      'rollback-cleanup',
      'config-mismatch',
      'key-rotation',
      'telemetry-failure',
    ].includes(mode) ||
    args.length > 1 ||
    (args.length === 1 &&
      !['--state=isolated', '--state=retained'].includes(args[0]))
  )
    throw new Error('Unsupported auth load stand mode.');
  if (mode === 'rollback-cleanup' && stateMode !== 'isolated')
    throw new Error('Rollback/cleanup requires an isolated test database.');
  if (mode === 'config-mismatch' && stateMode !== 'isolated')
    throw new Error(
      'Configuration mismatch requires an isolated test database.',
    );
  if (mode === 'key-rotation' && stateMode !== 'isolated')
    throw new Error('Key rotation requires an isolated test database.');
  if (mode === 'telemetry-failure' && stateMode !== 'isolated')
    throw new Error('Telemetry failure requires an isolated test database.');
  const target = testTarget('load', process.env.TEST_DATABASE_URL);
  const run = new TestRun();
  try {
    return await withTestWorkdir((directory) =>
      withLoadDatabase(target, run, directory, stateMode, async (database) => {
        const report = join(root, 'load-results', `${mode}-${Date.now()}.json`);
        const env = {
          ...testEnvironment(database),
          LOAD_REPORT_PATH: report,
          LOAD_STAND_SCENARIO: mode,
        };
        for (const key of [
          'LOAD_RATE',
          'LOAD_DURATION_SECONDS',
          'LOAD_PROVIDER_DELAY_MS',
          'LOAD_DRAIN_SECONDS',
        ]) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        await mkdir(dirname(report), { recursive: true });
        if (mode !== 'smoke') {
          const compiled = join(directory, 'compiled');
          const code = await run.command(
            [
              join(root, 'node_modules/typescript/bin/tsc'),
              '--project',
              join(root, 'test/load/tsconfig.replica.json'),
              '--outDir',
              compiled,
            ],
            { cwd: directory, env },
          );
          if (code !== 0) return code;
          await symlink(
            join(root, 'node_modules'),
            join(compiled, 'node_modules'),
          );
          env.LOAD_REPLICA_PATH = join(
            compiled,
            'test/load/concurrency-replica.js',
          );
        }
        console.log(`Load report target: ${report}`);
        const code = await run.command(
          [
            '--experimental-vm-modules',
            join(root, 'node_modules/jest/bin/jest.js'),
            '--config',
            join(
              root,
              `test/load/${mode === 'smoke' ? 'jest-load' : 'jest-concurrency'}.json`,
            ),
            '--runInBand',
          ],
          { cwd: directory, env },
        );
        if (code === 0) console.log(`Load report: ${report}`);
        return code;
      }),
    );
  } finally {
    run.dispose();
  }
}
try {
  process.exitCode = await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
