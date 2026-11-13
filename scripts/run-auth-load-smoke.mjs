import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  repositoryRoot as root,
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
  withTestDatabase,
} from './test-runtime.mjs';

async function main() {
  const mode = process.argv[2] ?? 'smoke';
  if (
    ![
      'smoke',
      'concurrency',
      'identity-isolation',
      'shared-ip',
      'mixed-mail',
    ].includes(mode) ||
    process.argv.length > 3
  )
    throw new Error('Unsupported auth load stand mode.');
  const target = testTarget('load', process.env.TEST_DATABASE_URL);
  const run = new TestRun();
  try {
    return await withTestWorkdir((directory) =>
      withTestDatabase(target, run, async (database) => {
        const report = join(root, 'load-results', `${mode}-${Date.now()}.json`);
        const env = {
          ...testEnvironment(target),
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
        await database.prepare(directory, env);
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
