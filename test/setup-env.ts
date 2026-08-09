process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/unicon_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_ACCESS_TTL_SECONDS ??= '900';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.SESSION_INACTIVITY_TTL_SECONDS ??= '31536000';
process.env.SESSION_MANAGEMENT_COOLDOWN_SECONDS ??= '86400';
process.env.SESSION_ACTIVE_LIMIT ??= '10';
process.env.SECURITY_EVENT_RETENTION_SECONDS ??= '15552000';
process.env.NOTIFICATION_DELIVERY_RETENTION_SECONDS ??= '15552000';
process.env.RESEND_API_KEY ??= 'test-resend-api-key';
process.env.MAIL_FROM ??= 'test@unicon.local';
process.env.CLIENT_URL ??= 'http://localhost:3001';
process.env.GEOIP_ENABLED ??= 'false';
process.env.GEOIP_DATABASE_PATH ??= 'data/geoip/GeoLite2-City.mmdb';
process.env.GEOIP_RELOAD_INTERVAL_SECONDS ??= '60';
