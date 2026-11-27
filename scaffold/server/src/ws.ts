import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { config } from './config.js';
import { isMember, loadSession } from './auth/session.js';
import { currentSeq, readSince, subscribe, type Frame } from './events/bus.js';

// GET /ws?workspace=<id>[&after=<seq>]
//
// Refused before the upgrade (so the client sees a failed handshake, not an open socket) when there is
// no session (401), the user is not a member of the workspace (403) or the request comes from another site (403).
// With ?after=N the client first gets every frame with seq > N that it missed, then live frames, with no
// gap and no repeat: live frames that arrive during the replay are held back and then filtered by seq.

const MAX_BUFFERED_BYTES = 1_000_000; // a client this far behind is cut off; it reconnects with ?after=lastSeq

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function allowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (or same-origin without the header)
  const own = new Set([config.webOrigin, new URL(config.oidc.redirectUri).origin, `http://${req.headers.host}`]);
  return own.has(origin);
}

export function attachWebSocket(server: Server, log: (...a: unknown[]) => void = console.error): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found');
      if (!allowedOrigin(req)) return refuse(socket, 403, 'Forbidden');
      const session = await loadSession(req.headers.cookie);
      if (!session) return refuse(socket, 401, 'Unauthorized');
      const workspace = url.searchParams.get('workspace');
      if (!workspace || !isMember(session, workspace)) return refuse(socket, 403, 'Forbidden');
      const afterParam = url.searchParams.get('after');
      if (afterParam !== null && !/^\d{1,15}$/.test(afterParam)) return refuse(socket, 400, 'Bad Request');
      wss.handleUpgrade(req, socket, head, (ws) => void serve(ws, workspace, afterParam === null ? null : Number(afterParam)));
    })().catch((err: Error) => {
      log('websocket upgrade failed:', err.message);
      refuse(socket, 503, 'Service Unavailable'); // e.g. Redis down: not a 401, the session may be fine
    });
  });

  async function serve(ws: WebSocket, workspace: string, after: number | null): Promise<void> {
    let lastSent = -1;
    let holding: Frame[] | null = []; // live frames that arrive while the replay is still being sent
    const deliver = (frame: Frame) => {
      if (frame.seq <= lastSent || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.close(1013, 'too slow; reconnect with after=');
      lastSent = frame.seq;
      ws.send(JSON.stringify(frame));
    };
    // Subscribe BEFORE reading history: anything published after this point is either in the
    // history read or held here, so nothing can fall in between.
    const unsubscribe = subscribe(workspace, (frame) => (holding ? holding.push(frame) : deliver(frame)));
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
    ws.on('message', () => undefined); // the protocol is server-to-client only
    try {
      if (after === null) {
        lastSent = await currentSeq(workspace); // live only: start after what exists now
      } else {
        lastSent = after;
        await readSince(workspace, after, (frames) => frames.forEach(deliver));
      }
      const held = holding;
      holding = null; // no await between these two lines and the flush: no frame can slip past
      held.forEach(deliver);
    } catch (err) {
      log('websocket replay failed:', (err as Error).message);
      unsubscribe();
      ws.close(1011, 'replay failed; reconnect');
    }
  }

  // Drop connections whose browser vanished without saying goodbye.
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
  });
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) ws.terminate();
      else {
        alive.delete(ws);
        ws.ping();
      }
    }
  }, 30_000).unref();
}
