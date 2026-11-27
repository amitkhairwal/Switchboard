import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';
import { getRedis } from '../redis.js';
import type { Session } from './session.js';

// OpenID Connect, authorization code flow with PKCE (S256).
//
// What a login needs between "send the browser to the IdP" and "the browser comes back"
// (the state, the PKCE verifier, the nonce) lives in Redis under the `state` value, not in
// this process and not in a cookie. So the callback can be answered by any copy of the
// server, not only the one that started the login.

export class AuthError extends Error {}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const LOGIN_TTL_SECONDS = 600;
let cached: { at: number; discovery: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

async function discover() {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`identity provider discovery answered ${res.status}`);
  const d = (await res.json()) as Partial<Discovery>;
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new Error('identity provider discovery is incomplete');
  // The IdP's signing key changes whenever it restarts, so keys are fetched from /jwks and
  // re-fetched when a token names a key id we have not seen.
  const jwks = createRemoteJWKSet(new URL(d.jwks_uri), { cooldownDuration: 1000 });
  return (cached = { at: Date.now(), discovery: d as Discovery, jwks });
}

const sha256url = (s: string) => createHash('sha256').update(s).digest('base64url');

// Step 1: where to send the browser.
export async function startLogin(): Promise<string> {
  const { discovery } = await discover();
  const state = randomBytes(16).toString('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  await getRedis().set(`sb:oidc:${state}`, JSON.stringify({ verifier, nonce }), 'EX', LOGIN_TTL_SECONDS);
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: sha256url(verifier),
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

const isRole = (r: unknown): r is 'admin' | 'agent' => r === 'admin' || r === 'agent';

// Step 2: the browser is back with ?code&state. Returns who they are and how long that is good for.
export async function finishLogin(code: string, state: string): Promise<{ session: Session; ttlSeconds: number }> {
  // GETDEL: a state works once, so a replayed callback cannot log anyone in twice.
  const stored = await getRedis().getdel(`sb:oidc:${state}`);
  if (!stored) throw new AuthError('this login attempt is unknown or has expired; start again');
  const { verifier, nonce } = JSON.parse(stored) as { verifier: string; nonce: string };

  const { discovery, jwks } = await discover();
  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      code_verifier: verifier,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new AuthError(`the identity provider refused the code (${res.status})`);
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  if (!idToken) throw new AuthError('the identity provider sent no id_token');

  // Signature (RS256 against the IdP's own /jwks), issuer, audience and expiry are all checked here.
  const { payload } = await jwtVerify(idToken, jwks, { issuer: config.oidc.issuer, audience: config.oidc.clientId, algorithms: ['RS256'] }).catch((err: Error) => {
    throw new AuthError(`the id_token is not valid: ${err.message}`);
  });
  if (payload.nonce !== nonce) throw new AuthError('the id_token was issued for a different login');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError('the id_token has no subject');

  const raw = Array.isArray(payload.workspaces) ? (payload.workspaces as unknown[]) : [];
  const workspaces = raw.flatMap((w) => {
    const o = w as { id?: unknown; role?: unknown };
    return typeof o?.id === 'string' && isRole(o.role) ? [{ id: o.id, role: o.role }] : [];
  });
  const left = typeof payload.exp === 'number' ? payload.exp - Math.floor(Date.now() / 1000) : 3600;
  return {
    session: {
      sub: payload.sub,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      workspaces,
    },
    ttlSeconds: Math.max(60, Math.min(left, 8 * 3600)), // never outlive the IdP's own token, never past a working day
  };
}
