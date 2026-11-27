import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.js';
import { graderRouter } from './grader/routes.js';
import type { PigeonStore } from './domain/store.js';
import { createPigeonHandler } from './webhooks/pigeon.js';

export function createApp(opts: { store: PigeonStore; isReady: () => boolean }) {
  const app = express();
  app.disable('x-powered-by');

  // 200 only when this copy can really serve: MongoDB and Redis reachable, indexes in place.
  app.get('/healthz', (_req, res) => {
    const ok = opts.isReady();
    res.status(ok ? 200 : 503).json({ ok });
  });

  // The webhook gets the raw bytes (the signature covers them); every other route gets JSON.
  const pigeonHandler = createPigeonHandler({
    secret: config.pigeon.webhookSecret,
    workspaces: new Set(config.workspaces),
    store: opts.store,
  });
  app.post('/webhooks/pigeon', express.raw({ type: () => true, limit: '2mb' }), (req, res, next) => {
    pigeonHandler(req, res).catch(next);
  });

  app.use(express.json({ limit: '1mb' }));
  app.use('/__grader', graderRouter);

  // Last resort. A storage failure on the webhook is a 5xx ON PURPOSE: Pigeon must
  // retry, because we did not store the event. Bad input never reaches here.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 503;
    if (status >= 500) console.error('request failed:', err.message);
    res.status(status).json({ error: status >= 500 ? 'temporarily unavailable' : err.message });
  });

  return app;
}
