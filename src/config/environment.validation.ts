const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'RESEND_API_KEY',
  'MAIL_FROM',
  'CLIENT_URL',
  'PASSWORD_RESET_RATE_LIMIT_SECRET',
] as const;

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

  validatedEnvironment.JWT_ACCESS_TTL_SECONDS = parsePositiveInteger(
    environment.JWT_ACCESS_TTL_SECONDS,
    'JWT_ACCESS_TTL_SECONDS',
  );
  validatedEnvironment.SESSION_INACTIVITY_TTL_SECONDS = parsePositiveInteger(
    environment.SESSION_INACTIVITY_TTL_SECONDS,
    'SESSION_INACTIVITY_TTL_SECONDS',
  );
  validatedEnvironment.SESSION_MANAGEMENT_COOLDOWN_SECONDS =
    parsePositiveInteger(
      environment.SESSION_MANAGEMENT_COOLDOWN_SECONDS,
      'SESSION_MANAGEMENT_COOLDOWN_SECONDS',
    );
  validatedEnvironment.SESSION_ACTIVE_LIMIT = parsePositiveInteger(
    environment.SESSION_ACTIVE_LIMIT,
    'SESSION_ACTIVE_LIMIT',
  );
  validatedEnvironment.SECURITY_EVENT_RETENTION_SECONDS = parsePositiveInteger(
    environment.SECURITY_EVENT_RETENTION_SECONDS,
    'SECURITY_EVENT_RETENTION_SECONDS',
  );
  validatedEnvironment.NOTIFICATION_DELIVERY_RETENTION_SECONDS =
    parsePositiveInteger(
      environment.NOTIFICATION_DELIVERY_RETENTION_SECONDS,
      'NOTIFICATION_DELIVERY_RETENTION_SECONDS',
    );
  validatedEnvironment.RISK_LOGIN_FAILURE_WINDOW_SECONDS = parsePositiveInteger(
    environment.RISK_LOGIN_FAILURE_WINDOW_SECONDS,
    'RISK_LOGIN_FAILURE_WINDOW_SECONDS',
  );
  validatedEnvironment.RISK_LOGIN_FAILURE_THRESHOLD = parsePositiveInteger(
    environment.RISK_LOGIN_FAILURE_THRESHOLD,
    'RISK_LOGIN_FAILURE_THRESHOLD',
  );
  validatedEnvironment.RISK_NEW_SESSION_WINDOW_SECONDS = parsePositiveInteger(
    environment.RISK_NEW_SESSION_WINDOW_SECONDS,
    'RISK_NEW_SESSION_WINDOW_SECONDS',
  );
  validatedEnvironment.RISK_NEW_SESSION_THRESHOLD = parsePositiveInteger(
    environment.RISK_NEW_SESSION_THRESHOLD,
    'RISK_NEW_SESSION_THRESHOLD',
  );
  validatedEnvironment.PASSWORD_RESET_TOKEN_TTL_SECONDS = parsePositiveInteger(
    environment.PASSWORD_RESET_TOKEN_TTL_SECONDS,
    'PASSWORD_RESET_TOKEN_TTL_SECONDS',
  );
  validatedEnvironment.PASSWORD_RESET_REQUEST_WINDOW_SECONDS =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_WINDOW_SECONDS,
      'PASSWORD_RESET_REQUEST_WINDOW_SECONDS',
    );
  validatedEnvironment.PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL,
      'PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL',
    );
  validatedEnvironment.PASSWORD_RESET_REQUEST_LIMIT_PER_IP =
    parsePositiveInteger(
      environment.PASSWORD_RESET_REQUEST_LIMIT_PER_IP,
      'PASSWORD_RESET_REQUEST_LIMIT_PER_IP',
    );

  validatedEnvironment.PORT = parsePort(environment.PORT);
  validatedEnvironment.GEOIP_ENABLED = parseBoolean(
    environment.GEOIP_ENABLED,
    'GEOIP_ENABLED',
    false,
  );
  validatedEnvironment.GEOIP_DATABASE_PATH = getRequiredString(
    environment,
    'GEOIP_DATABASE_PATH',
  );
  validatedEnvironment.GEOIP_RELOAD_INTERVAL_SECONDS = parsePositiveInteger(
    environment.GEOIP_RELOAD_INTERVAL_SECONDS,
    'GEOIP_RELOAD_INTERVAL_SECONDS',
  );

  return validatedEnvironment;
}

function parseBoolean(
  value: unknown,
  key: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined || value === '') {
    return defaultValue;
  }

  if (value === true || value === 'true') {
    return true;
  }

  if (value === false || value === 'false') {
    return false;
  }

  throw new Error(`Environment variable ${key} must be true or false.`);
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

function parsePositiveInteger(value: unknown, key: string): number {
  const parsedValue = typeof value === 'number' ? value : Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer.`);
  }

  return parsedValue;
}
