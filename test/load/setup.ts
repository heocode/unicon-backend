// Explicit smoke configuration; never inherit the large general-e2e budgets.
process.env.AUTH_DELIVERY_GLOBAL_BURST = '100';
process.env.AUTH_DELIVERY_GLOBAL_RATE = '120';
process.env.AUTH_DELIVERY_GLOBAL_PERIOD_SECONDS = '60';
process.env.AUTH_DELIVERY_BACKLOG_LIMIT = '1000';
