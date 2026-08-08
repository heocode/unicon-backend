process.env.DATABASE_URL ??=
  'postgresql://postgres:postgres@localhost:5432/unicon_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_ACCESS_EXPIRES_IN ??= '15m';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.JWT_REFRESH_EXPIRES_IN ??= '7d';
process.env.RESEND_API_KEY ??= 'test-resend-api-key';
process.env.MAIL_FROM ??= 'test@unicon.local';
process.env.CLIENT_URL ??= 'http://localhost:3001';
