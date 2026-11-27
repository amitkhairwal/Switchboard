import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initStore, mongoStore } from './domain/store.js';
import { startEventReaders } from './events/bus.js';
import { attachWebSocket } from './ws.js';
import { createLimiter } from './outbox/limiter.js';
import { sendViaPigeon } from './outbox/pigeonClient.js';
import { createOutboxWorker } from './outbox/worker.js';
import { getRedis } from './redis.js';
import { startTimingReport } from './timing.js';

startTimingReport(); // no-op unless SB_TIMING=1
let ready = false;
const app = createApp({ store: mongoStore, isReady: () => ready });

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

const server = createServer(app);
attachWebSocket(server); // GET /ws
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

(async function boot() {
  for (;;) {
    try {
      await initStore();
      startEventReaders(config.workspaces); // fan out events published by any copy to this copy's sockets
      createOutboxWorker({
        send: sendViaPigeon,
        limiter: createLimiter(getRedis(), { capacity: config.outbox.bucketCapacity, refillPerSec: config.outbox.bucketRefillPerSec }),
        workspaces: config.workspaces,
        leaseMs: config.outbox.leaseMs,
        pollMs: config.outbox.pollMs,
        maxInflightPerWorkspace: config.outbox.maxInflightPerWorkspace,
        backoffBaseMs: config.outbox.backoffBaseMs,
        backoffCapMs: config.outbox.backoffCapMs,
      }).start();
      ready = true;
      console.log('ready');
      return;
    } catch (e) {
      console.error('waiting for MongoDB/Redis:', (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();
