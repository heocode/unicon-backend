import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { testDatabaseRuntime } from './utils/test-database-runtime';

// This runs before AppModule can inspect cwd/.env. Direct Jest invocation is
// unsupported: use the guarded npm e2e/load commands.
testDatabaseRuntime();
if (
  existsSync(resolve(process.cwd(), '.env')) ||
  resolve(process.cwd()) === resolve(__dirname, '..')
)
  throw new Error(
    'Tests require the guarded launcher and an isolated working directory.',
  );

process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_ACCESS_TTL_SECONDS ??= '900';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.SESSION_INACTIVITY_TTL_SECONDS ??= '31536000';
process.env.SESSION_MANAGEMENT_COOLDOWN_SECONDS ??= '86400';
process.env.SESSION_ACTIVE_LIMIT ??= '10';
process.env.SECURITY_EVENT_RETENTION_SECONDS ??= '15552000';
process.env.NOTIFICATION_DELIVERY_RETENTION_SECONDS ??= '15552000';
process.env.RISK_LOGIN_FAILURE_WINDOW_SECONDS ??= '900';
process.env.RISK_LOGIN_FAILURE_THRESHOLD ??= '5';
process.env.RISK_NEW_SESSION_WINDOW_SECONDS ??= '3600';
process.env.RISK_NEW_SESSION_THRESHOLD ??= '3';
process.env.PASSWORD_RESET_TOKEN_TTL_SECONDS ??= '1800';
process.env.PASSWORD_RESET_REQUEST_WINDOW_SECONDS ??= '900';
process.env.PASSWORD_RESET_REQUEST_LIMIT_PER_EMAIL ??= '3';
process.env.PASSWORD_RESET_REQUEST_LIMIT_PER_IP ??= '10';
process.env.PASSWORD_RESET_RATE_LIMIT_SECRET ??= 'test-recovery-rate-secret';
process.env.ACCOUNT_DELETION_GRACE_PERIOD_SECONDS ??= '2592000';
process.env.ACCOUNT_DELETION_FINALIZATION_BATCH_SIZE ??= '100';
process.env.ACCOUNT_DELETION_CANCEL_WINDOW_SECONDS ??= '900';
process.env.ACCOUNT_DELETION_CANCEL_LIMIT_PER_EMAIL ??= '5';
process.env.ACCOUNT_DELETION_CANCEL_LIMIT_PER_IP ??= '20';
process.env.ACCOUNT_DELETION_CANCEL_RATE_LIMIT_SECRET ??=
  'test-account-deletion-cancel-rate-secret';
process.env.AUTH_CHALLENGE_TTL_SECONDS ??= '600';
process.env.AUTH_CHALLENGE_RETENTION_SECONDS ??= '86400';
process.env.AUTH_CHALLENGE_CLEANUP_INTERVAL_SECONDS ??= '60';
process.env.AUTH_CHALLENGE_CLEANUP_BATCH_SIZE ??= '100';
process.env.AUTH_CHALLENGE_CLEANUP_MAX_BATCHES_PER_RUN ??= '10';
process.env.AUTH_DELIVERY_BACKLOG_LIMIT ??= '1000';
process.env.AUTH_DELIVERY_MAX_PROCESSING_ATTEMPTS ??= '5';
process.env.AUTH_DELIVERY_RETRY_BACKOFF_SECONDS ??= '5,15,30,60';
process.env.AUTH_DELIVERY_RETRY_JITTER_PERCENT ??= '20';
process.env.AUTH_DELIVERY_HTTP_TIMEOUT_SECONDS ??= '10';
process.env.AUTH_DELIVERY_PROCESSING_LEASE_SECONDS ??= '45';
process.env.AUTH_DELIVERY_MIN_VALIDITY_REMAINING_SECONDS ??= '120';
process.env.AUTH_DELIVERY_PROVIDER_IDEMPOTENCY_WINDOW_SECONDS ??= '86400';
process.env.AUTH_DELIVERY_WORKER_INTERVAL_SECONDS ??= '1';
process.env.AUTH_DELIVERY_WORKER_CONCURRENCY ??= '4';
process.env.AUTH_DELIVERY_WORKER_MAX_DELIVERIES_PER_CYCLE ??= '20';
process.env.AUTH_DELIVERY_WORKER_EXHAUSTED_LEASE_BATCH_SIZE ??= '100';
process.env.AUTH_CHALLENGE_DELIVERY_COOLDOWN_SECONDS ??= '60';
process.env.AUTH_IDENTITY_DELIVERY_COOLDOWN_SECONDS ??= '60';
// Large shared test defaults avoid coupling unrelated service suites. Focused
// global-admission tests use a small explicit budget and clean its fixed test key.
process.env.AUTH_DELIVERY_GLOBAL_BURST ??= '10000';
process.env.AUTH_DELIVERY_GLOBAL_RATE ??= '10000';
process.env.AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS ??= '60';
process.env.AUTH_DELIVERY_IDENTITY_BURST ??= '10';
process.env.AUTH_DELIVERY_IDENTITY_RATE ??= '7';
process.env.AUTH_DELIVERY_IDENTITY_PERIOD_SECONDS ??= '3600';
process.env.AUTH_DELIVERY_IP_BURST ??= '120';
process.env.AUTH_DELIVERY_IP_RATE ??= '240';
process.env.AUTH_DELIVERY_IP_PERIOD_SECONDS ??= '3600';
process.env.AUTH_VERIFICATION_IDENTITY_SHORT_BURST ??= '6';
process.env.AUTH_VERIFICATION_IDENTITY_SHORT_RATE ??= '6';
process.env.AUTH_VERIFICATION_IDENTITY_SHORT_PERIOD_SECONDS ??= '60';
process.env.AUTH_VERIFICATION_IP_SHORT_BURST ??= '72';
process.env.AUTH_VERIFICATION_IP_SHORT_RATE ??= '72';
process.env.AUTH_VERIFICATION_IP_SHORT_PERIOD_SECONDS ??= '60';
process.env.AUTH_VERIFICATION_IDENTITY_LONG_BURST ??= '8';
process.env.AUTH_VERIFICATION_IDENTITY_LONG_RATE ??= '12';
process.env.AUTH_VERIFICATION_IDENTITY_LONG_PERIOD_SECONDS ??= '3600';
process.env.AUTH_VERIFICATION_IP_LONG_BURST ??= '360';
process.env.AUTH_VERIFICATION_IP_LONG_RATE ??= '360';
process.env.AUTH_VERIFICATION_IP_LONG_PERIOD_SECONDS ??= '3600';
process.env.HTTP_PUBLIC_PASSWORDLESS_REQUEST_BURST ??= '200';
process.env.HTTP_PUBLIC_PASSWORDLESS_REQUEST_RATE ??= '600';
process.env.HTTP_PUBLIC_PASSWORDLESS_REQUEST_PERIOD_SECONDS ??= '60';
process.env.AUTH_MAGIC_LINK_PUBLIC_URL ??=
  'https://uniconnection.app/auth/verify';
process.env.AUTH_EMAIL_FROM ??= 'Unicon <noreply@uniconnection.app>';
process.env.AUTH_CHALLENGE_HMAC_ACTIVE_KEY_VERSION ??= '1';
process.env.AUTH_CHALLENGE_HMAC_KEYS ??=
  '1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
process.env.AUTH_CHALLENGE_ENCRYPTION_ACTIVE_KEY_VERSION ??= '1';
process.env.AUTH_CHALLENGE_ENCRYPTION_KEYS ??=
  '1:AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=';
process.env.RATE_LIMIT_HMAC_ACTIVE_KEY_VERSION ??= '1';
process.env.RATE_LIMIT_HMAC_KEYS ??= `1:${Buffer.alloc(32, 4).toString('base64')}`;
process.env.RATE_LIMIT_TRANSACTION_MAX_ATTEMPTS ??= '3';
process.env.RATE_LIMIT_TRANSACTION_TIMEOUT_SECONDS ??= '5';
process.env.RATE_LIMIT_TRANSACTION_MAX_WAIT_SECONDS ??= '2';
process.env.MAIL_RESEND_SUBMISSIONS_PER_SECOND ??= '8';
process.env.MAIL_RESEND_TEAM_REQUESTS_PER_SECOND ??= '10';
process.env.MAIL_RESEND_RATE_LIMIT_FALLBACK_SECONDS ??= '1';
process.env.RESEND_API_KEY ??= 'test-resend-api-key';
process.env.MAIL_FROM ??= 'test@unicon.local';
process.env.CLIENT_URL ??= 'http://localhost:3001';
process.env.GEOIP_ENABLED ??= 'false';
process.env.GEOIP_DATABASE_PATH ??= 'data/geoip/GeoLite2-City.mmdb';
process.env.GEOIP_RELOAD_INTERVAL_SECONDS ??= '60';

process.env.MAIL_DELIVERY_ENCRYPTION_KEYS ??= `1:${Buffer.alloc(32, 9).toString('base64')}`;
process.env.MAIL_DELIVERY_ENCRYPTION_ACTIVE_KEY_VERSION ??= '1';
process.env.MAIL_DELIVERY_MAX_AGE_SECONDS ??= '82800';
process.env.MAIL_DELIVERY_LEASE_SECONDS ??= '45';
process.env.MAIL_DELIVERY_HTTP_TIMEOUT_SECONDS ??= '10';
process.env.MAIL_DELIVERY_WORKER_INTERVAL_SECONDS ??= '1';
process.env.MAIL_DELIVERY_WORKER_BATCH_SIZE ??= '20';
