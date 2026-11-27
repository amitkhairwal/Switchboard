import { Router } from 'express';
import { config } from '../config.js';
import { wrap } from '../grader/routes.js';
import { AuthError, finishLogin, startLogin } from './oidc.js';
import { clearedCookie, createSession, destroySession, sessionCookie } from './session.js';

export const authRouter = Router();

authRouter.get('/login', wrap(async (_req, res) => {
  res.redirect(302, await startLogin());
}));

authRouter.get('/callback', wrap(async (req, res) => {
  const { code, state, error } = req.query;
  if (typeof error === 'string') {
    res.status(400).json({ error: `the identity provider reported: ${error}` });
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    res.status(400).json({ error: 'code and state are required' });
    return;
  }
  try {
    const { session, ttlSeconds } = await finishLogin(code, state);
    res.setHeader('set-cookie', sessionCookie(await createSession(session, ttlSeconds), ttlSeconds));
    res.redirect(302, config.webOrigin + '/'); // back to the web app (cookies are not port-scoped, so it is sent there too)
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err; // IdP or Redis unreachable: 503 from the error handler
  }
}));

authRouter.post('/logout', wrap(async (req, res) => {
  await destroySession(req.headers.cookie);
  res.setHeader('set-cookie', clearedCookie());
  res.status(204).end();
}));
