// Explicit smoke configuration; never inherit the large general-e2e budgets.
process.env.AUTH_DELIVERY_GLOBAL_BURST = '100';
process.env.AUTH_DELIVERY_GLOBAL_RATE = '120';
process.env.AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS = '60';
process.env.AUTH_DELIVERY_BACKLOG_LIMIT = '1000';

// Bounded shared-IP experiment only. Each run uses fresh IPs; do not retune or
// reset previously retained buckets, and do not export these as production values.
if (process.env.LOAD_STAND_SCENARIO === 'shared-ip') {
  process.env.AUTH_DELIVERY_IP_BURST = '3';
  process.env.AUTH_DELIVERY_IP_RATE = '1';
  process.env.AUTH_DELIVERY_IP_PERIOD_SECONDS = '3600';
}
