import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initStore, mongoStore } from './domain/store.js';

let ready = false;
const app = createApp({ store: mongoStore, isReady: () => ready });

process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

// A plain http server, so WebSockets can attach to it later.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

(async function boot() {
  for (;;) {
    try {
      await initStore();
      ready = true;
      console.log('ready');
      return;
    } catch (e) {
      console.error('waiting for MongoDB/Redis:', (e as Error).message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();
