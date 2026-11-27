// Dev helper (run inside the dev container, with the server on :4000):
// times signed webhooks one at a time and then 30 at once.
import { createHmac, randomBytes } from 'node:crypto';

const SECRET = 'whsec_pigeon_dev';
const URL = 'http://localhost:4000/webhooks/pigeon';
const ev = (i) =>
  JSON.stringify({
    id: 'evt_probe' + randomBytes(4).toString('hex') + i,
    type: 'message.inbound',
    workspace: 'ws_globex',
    occurred_at: new Date().toISOString(),
    data: { message_id: 'pmsg_probe' + randomBytes(6).toString('hex'), from: process.env.SPREAD ? '+4420794602' + (10 + (i % 90)) : '+442079460201', text: 'probe' },
  });
const post = async (raw) => {
  const t = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', SECRET).update(t + '.' + raw).digest('hex');
  const start = performance.now();
  const res = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pigeon-signature': `t=${t},v1=${mac}` }, body: raw });
  await res.arrayBuffer();
  return { status: res.status, ms: Math.round(performance.now() - start) };
};
const summary = (rs) => {
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  return `n=${ms.length} statuses=${[...new Set(rs.map((r) => r.status))]} p50=${ms[Math.floor(ms.length / 2)]}ms p95=${ms[Math.floor(ms.length * 0.95)]}ms max=${ms[ms.length - 1]}ms`;
};

await post(ev(-1)); // warm-up
const serial = [];
for (let i = 0; i < 30; i++) serial.push(await post(ev(i)));
console.log('serial  ', summary(serial));
const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => post(ev(100 + i))));
console.log('burst-30', summary(burst));
