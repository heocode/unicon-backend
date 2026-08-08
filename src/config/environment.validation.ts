const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_ACCESS_EXPIRES_IN',
  'JWT_REFRESH_SECRET',
  'JWT_REFRESH_EXPIRES_IN',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CLIENT_URL',
] as const;

const JWT_EXPIRATION_PATTERN = /^\d+(?:ms|s|m|h|d|w|y)$/;

export function validateEnvironment(
  environment: Record<string, unknown>,
): Record<string, unknown> {
  const validatedEnvironment = { ...environment };

  for (const key of REQUIRED_ENVIRONMENT_VARIABLES) {
    validatedEnvironment[key] = getRequiredString(environment, key);
  }

  validateUrl(validatedEnvironment.DATABASE_URL, 'DATABASE_URL', [
    'postgres:',
    'postgresql:',
  ]);
  validateUrl(validatedEnvironment.CLIENT_URL, 'CLIENT_URL', [
    'http:',
    'https:',
  ]);

  validateJwtExpiration(
    validatedEnvironment.JWT_ACCESS_EXPIRES_IN,
    'JWT_ACCESS_EXPIRES_IN',
  );
  validateJwtExpiration(
    validatedEnvironment.JWT_REFRESH_EXPIRES_IN,
    'JWT_REFRESH_EXPIRES_IN',
  );

  validatedEnvironment.PORT = parsePort(environment.PORT);

  return validatedEnvironment;
}

function getRequiredString(
  environment: Record<string, unknown>,
  key: string,
): string {
  const value = environment[key];

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Environment variable ${key} is required.`);
  }

  return value.trim();
}

function validateUrl(value: unknown, key: string, protocols: string[]): void {
  if (typeof value !== 'string') {
    throw new Error(`Environment variable ${key} must be a valid URL.`);
  }

  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`Environment variable ${key} must be a valid URL.`);
  }

  if (!protocols.includes(url.protocol)) {
    throw new Error(
      `Environment variable ${key} must use one of these protocols: ${protocols.join(', ')}.`,
    );
  }
}

function validateJwtExpiration(value: unknown, key: string): void {
  if (typeof value !== 'string' || !JWT_EXPIRATION_PATTERN.test(value)) {
    throw new Error(
      `Environment variable ${key} must be a duration such as 15m, 7d, or 1000ms.`,
    );
  }
}

function parsePort(value: unknown): number {
  if (value === undefined || value === '') {
    return 3000;
  }

  const port = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Environment variable PORT must be an integer between 1 and 65535.',
    );
  }

  return port;
}
