// Test-only destination policy, shared by Jest setup, observers and OS replicas.
export function testDatabaseRuntime(env: NodeJS.ProcessEnv = process.env) {
  const kind = env.UNICON_TEST_TARGET;
  const runId = env.UNICON_TEST_RUN_ID;
  const stateMode = kind === 'e2e' ? 'isolated' : env.LOAD_DATABASE_STATE;
  if (
    (kind !== 'e2e' && kind !== 'load') ||
    !runId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      runId,
    ) ||
    (stateMode !== 'isolated' && stateMode !== 'retained')
  )
    throw new Error(
      'Use the guarded test launcher and a valid database lifecycle.',
    );
  let url: URL;
  try {
    url = new URL(env.TEST_DATABASE_URL ?? '');
  } catch {
    throw new Error('Invalid guarded test database URL.');
  }
  const database =
    kind === 'load' && stateMode === 'retained'
      ? 'unicon_load_test'
      : `unicon_${kind}_${runId.replaceAll('-', '')}_test`;
  if (
    env.DOTENV_CONFIG_PATH !== '/dev/null' ||
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    url.username !== 'unicon_e2e' ||
    !url.password ||
    url.pathname !== `/${database}` ||
    url.search ||
    url.hash ||
    env.DATABASE_URL !== url.toString()
  )
    throw new Error('Unexpected guarded test database destination.');
  return {
    kind,
    databaseLifecycle: {
      runId,
      stateMode,
      initialState: stateMode === 'isolated' ? 'template' : 'retained',
    },
  };
}

export function loadDatabaseRuntime(env: NodeJS.ProcessEnv = process.env) {
  const runtime = testDatabaseRuntime(env);
  if (runtime.kind !== 'load')
    throw new Error('Use the guarded load launcher.');
  return runtime.databaseLifecycle;
}
