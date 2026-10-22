// Crossing the real 256-entry LRU requires hundreds of synchronous fsyncs.
// This bounded persistence workload needs a hang guard, not a 5-second latency claim.
export const DISMISSAL_CHURN_TIMEOUT_MS = 30_000;
