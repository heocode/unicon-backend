import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Guarded e2e runtime', () => {
  it('uses its own temporary DB and public test settings outside repository cwd', () => {
    const runId = process.env.UNICON_TEST_RUN_ID!;
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new URL(process.env.DATABASE_URL!).pathname).toBe(
      `/unicon_e2e_${runId.replaceAll('-', '')}_test`,
    );
    expect(process.env.UNICON_TEST_TARGET).toBe('e2e');
    expect(process.env.DOTENV_CONFIG_PATH).toBe('/dev/null');
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.RESEND_API_KEY).toBe('test-resend-api-key');
    expect(process.env.JWT_ACCESS_SECRET).toBe('test-access-secret');
    expect(realpathSync(process.cwd())).not.toBe(
      realpathSync(resolve(__dirname, '..')),
    );
    expect(existsSync(resolve(process.cwd(), '.env'))).toBe(false);
  });
});
