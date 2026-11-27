import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

// Sessions live in Redis (`sb:sess:<id>`), so any copy can serve any request. The cookie holds only
// a random 256-bit id: it carries no data and cannot be forged, and deleting the Redis key
// logs the user out everywhere at once.

export const COOKIE_NAME = 'sb_session';

export interface Session {
  sub: string;
  name?: string;
  email?: string;
  workspaces: { id: string; role: 'admin' | 'agent' }[];
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const ID_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export async function createSession(session: Session, ttlSeconds: number): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await getRedis().set(`sb:sess:${id}`, JSON.stringify(session), 'EX', ttlSeconds);
  return id;
}

export async function destroySession(cookieHeader: string | undefined): Promise<void> {
  const id = parseCookies(cookieHeader)[COOKIE_NAME];
  if (id && ID_SHAPE.test(id)) await getRedis().del(`sb:sess:${id}`);
}

// null = not signed in. Throws if Redis cannot be reached, which callers must NOT read as "signed out".
export async function loadSession(cookieHeader: string | undefined): Promise<Session | null> {
  const id = parseCookies(cookieHeader)[COOKIE_NAME];
  if (!id || !ID_SHAPE.test(id)) return null;
  const raw = await getRedis().get(`sb:sess:${id}`);
  return raw ? (JSON.parse(raw) as Session) : null;
}

export const isMember = (s: Session, workspace: string): boolean => s.workspaces.some((w) => w.id === workspace);

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  const secure = config.webOrigin.startsWith('https:') ? '; Secure' : '';
  return `${COOKIE_NAME}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
export const clearedCookie = (): string => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  loadSession(req.headers.cookie)
    .then((session) => {
      if (!session) {
        res.status(401).json({ error: 'not signed in' });
        return;
      }
      res.locals.session = session;
      next();
    })
    .catch(next); // Redis trouble becomes a 503 from the error handler, not a false 401
}
