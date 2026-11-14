import { join } from 'node:path';
import {
  repositoryRoot,
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
} from './test-runtime.mjs';
import { withE2eDatabase } from './e2e-database.mjs';

// No dotenv. Only explicit public test configuration reaches subprocesses.
async function main() {
  const target = testTarget('e2e', process.env.TEST_DATABASE_URL);
  const args = process.argv.slice(2);
  // Existing suites share fixture tables and must run serially.
  if (
    args.some(
      (arg) =>
        !['--runInBand', '--verbose', '--silent'].includes(arg) &&
        !arg.startsWith('--testPathPatterns=') &&
        !arg.startsWith('--testNamePattern='),
    )
  ) {
    throw new Error(
      'Unsupported e2e argument. Use --runInBand, --verbose, --silent, --testPathPatterns= or --testNamePattern=.',
    );
  }
  const run = new TestRun();
  try {
    return await withTestWorkdir(async (directory) => {
      return withE2eDatabase(target, run, directory, async (database) => {
        const env = testEnvironment(database);
        return run.command(
          [
            '--experimental-vm-modules',
            join(repositoryRoot, 'node_modules/jest/bin/jest.js'),
            '--config',
            join(repositoryRoot, 'test/jest-e2e.json'),
            '--runInBand',
            ...args.filter((arg) => arg !== '--runInBand'),
          ],
          { cwd: directory, env },
        );
      });
    });
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
