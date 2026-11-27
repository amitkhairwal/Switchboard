// Dev helper (run inside the dev container, with the server on :4000):
// resets, runs Pigeon's chaos profile for 20 s, prints what Pigeon saw of our acks.
const P = 'http://localhost:4010';
const post = (path, body) => fetch(P + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
await fetch('http://localhost:4000/__grader/reset', { method: 'POST', headers: { 'x-grader-token': 'grader-dev-token' } });
await post('/__admin/reset');
await post('/__admin/start', { profile: 'chaos', seconds: 20 });
await new Promise((r) => setTimeout(r, 34000));
const r = await (await fetch(P + '/__admin/report')).json();
console.log(JSON.stringify(r.webhooks));
