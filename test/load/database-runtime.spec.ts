import {
  loadDatabaseRuntime,
  testDatabaseRuntime,
} from '../utils/test-database-runtime';

const runId = '12345678-1234-4123-8123-123456789abc';
const url = `postgresql://unicon_e2e:public-test-password@localhost:5433/unicon_load_${runId.replaceAll('-', '')}_test`;
const fixture = (): NodeJS.ProcessEnv => ({
  UNICON_TEST_TARGET: 'load',
  UNICON_TEST_RUN_ID: runId,
  LOAD_DATABASE_STATE: 'isolated',
  DOTENV_CONFIG_PATH: '/dev/null',
  TEST_DATABASE_URL: url,
  DATABASE_URL: url,
});

describe('Load database runtime boundary', () => {
  it('accepts isolated copies and returns only safe lifecycle metadata', () => {
    expect(loadDatabaseRuntime(fixture())).toEqual({
      runId,
      stateMode: 'isolated',
      initialState: 'template',
    });
  });
  it('accepts only explicit retained mode on the fixed load database', () => {
    const env = fixture();
    env.LOAD_DATABASE_STATE = 'retained';
    env.TEST_DATABASE_URL = env.DATABASE_URL = url.replace(
      /unicon_load_[a-f0-9]+_test$/,
      'unicon_load_test',
    );
    expect(loadDatabaseRuntime(env)).toEqual({
      runId,
      stateMode: 'retained',
      initialState: 'retained',
    });
    env.LOAD_DATABASE_STATE = 'isolated';
    expect(() => loadDatabaseRuntime(env)).toThrow();
  });
  it('rejects wrong run, missing markers, template and unsafe endpoint overrides', () => {
    const changes: NodeJS.ProcessEnv[] = [
      { UNICON_TEST_RUN_ID: undefined },
      { UNICON_TEST_RUN_ID: 'another-run' },
      { LOAD_DATABASE_STATE: undefined },
      { LOAD_DATABASE_STATE: 'unknown' },
      { UNICON_TEST_TARGET: 'template' },
      { DOTENV_CONFIG_PATH: '.env' },
      { DATABASE_URL: 'different-url' },
    ];
    for (const change of changes)
      expect(() => loadDatabaseRuntime({ ...fixture(), ...change })).toThrow();
    for (const destination of [
      url.replace('5433', '5432'),
      url.replace('localhost', 'example.com'),
      url.replace('unicon_e2e:', 'postgres:'),
      `${url}?host=example.com`,
      url.replace(/unicon_load_[a-f0-9]+_test$/, 'unicon_e2e_template'),
      url.replace(runId.replaceAll('-', ''), '0'.repeat(32)),
    ])
      expect(() =>
        loadDatabaseRuntime({
          ...fixture(),
          DATABASE_URL: destination,
          TEST_DATABASE_URL: destination,
        }),
      ).toThrow();
  });
  it('keeps e2e destinations separate from load destinations', () => {
    const env = {
      ...fixture(),
      UNICON_TEST_TARGET: 'e2e',
      DATABASE_URL: url.replace('/unicon_load_', '/unicon_e2e_'),
      TEST_DATABASE_URL: url.replace('/unicon_load_', '/unicon_e2e_'),
    };
    expect(testDatabaseRuntime(env).kind).toBe('e2e');
    expect(() => loadDatabaseRuntime(env)).toThrow();
  });
});
