// Every setting comes from the environment. The defaults match the harness,
// so this runs with no .env file. If ../../.env exists it is loaded first.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: defaults apply
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const config = {
  port: Number(env('PORT', '4000')),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  graderToken: env('GRADER_TOKEN', 'grader-dev-token'),
  mongoUrl: env('MONGO_URL', 'mongodb://localhost:27017/switchboard'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  elasticsearchUrl: env('ELASTICSEARCH_URL', 'http://localhost:9200'),
  pigeon: {
    url: env('PIGEON_URL', 'http://localhost:4010'),
    webhookSecret: env('PIGEON_WEBHOOK_SECRET', 'whsec_pigeon_dev'),
    apiKeys: {
      ws_acme: env('PIGEON_KEY_WS_ACME', 'pk_acme_7d1f0a'),
      ws_globex: env('PIGEON_KEY_WS_GLOBEX', 'pk_globex_c93b22'),
    } as Record<string, string>,
  },
  // The businesses this deployment serves (each has a Pigeon key above).
  workspaces: ['ws_acme', 'ws_globex'] as string[],
  outbox: {
    // One attempt at Pigeon gives up after this long. Pigeon's slow path answers after
    // 12 s, so we will always time out on it and rely on the Idempotency-Key to retry.
    attemptTimeoutMs: Number(env('OUTBOX_ATTEMPT_TIMEOUT_MS', '3000')),
    // A claimed row is ours for this long. It must outlast one attempt (3 s) with margin,
    // and be short enough that a dead copy's rows are re-taken well inside 60 s.
    leaseMs: Number(env('OUTBOX_LEASE_MS', '10000')),
    pollMs: Number(env('OUTBOX_POLL_MS', '150')),
    maxInflightPerWorkspace: Number(env('OUTBOX_MAX_INFLIGHT', '4')),
    backoffBaseMs: Number(env('OUTBOX_BACKOFF_BASE_MS', '500')),
    backoffCapMs: Number(env('OUTBOX_BACKOFF_CAP_MS', '5000')),
    // Pigeon allows a burst of 8 refilling at 4/s per workspace. We stay just under it.
    bucketCapacity: Number(env('OUTBOX_BUCKET_CAPACITY', '7')),
    bucketRefillPerSec: Number(env('OUTBOX_BUCKET_REFILL', '3.5')),
  },
  oidc: {
    issuer: env('OIDC_ISSUER', 'http://localhost:4020'),
    clientId: env('OIDC_CLIENT_ID', 'switchboard-web'),
    clientSecret: env('OIDC_CLIENT_SECRET', 'dev-secret-not-for-production'),
    redirectUri: env('OIDC_REDIRECT_URI', 'http://localhost:4000/auth/callback'),
  },
  paybox: {
    url: env('PAYBOX_URL', 'http://localhost:4030'),
    secretKey: env('PAYBOX_SECRET_KEY', 'sk_test_paybox_51c0de'),
    publishableKey: env('PAYBOX_PUBLISHABLE_KEY', 'pk_test_paybox_9a7b3e'),
    webhookSecret: env('PAYBOX_WEBHOOK_SECRET', 'whsec_paybox_dev'),
  },
};
