import {
  testTarget,
  testEnvironment,
  TestRun,
  withTestWorkdir,
  withTestDatabase,
} from './test-runtime.mjs';

// Standalone preparation uses the same target checks/lock as the complete run.
const run = new TestRun();
try {
  if (process.argv.length !== 2)
    throw new Error('Test database preparation accepts no arguments.');
  const target = testTarget('e2e', process.env.TEST_DATABASE_URL);
  await withTestWorkdir((directory) =>
    withTestDatabase(target, run, (database) =>
      database.prepare(directory, testEnvironment(target)),
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  run.dispose();
}
