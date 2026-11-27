import { monitorEventLoopDelay } from 'node:perf_hooks';

// Debug-only stage timing. Off unless SB_TIMING=1, and then it costs one
// boolean check per call. It prints a summary every 2 s to stderr (which the
// check harness writes to .check-logs/instance-N.log).
export const TIMING = process.env.SB_TIMING === '1';

const windowSamples = new Map<string, number[]>();

export function record(stage: string, ms: number): void {
  if (!TIMING) return;
  let list = windowSamples.get(stage);
  if (!list) windowSamples.set(stage, (list = []));
  list.push(ms);
}

export async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  if (!TIMING) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(stage, performance.now() - start);
  }
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

export function startTimingReport(): void {
  if (!TIMING) return;
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  setInterval(() => {
    if (windowSamples.size === 0) {
      loop.reset();
      return;
    }
    const clock = new Date().toISOString().slice(11, 19);
    const parts = [...windowSamples.entries()].map(([stage, xs]) => {
      xs.sort((a, b) => a - b);
      return `${stage}[n=${xs.length} p50=${pct(xs, 0.5).toFixed(0)} p95=${pct(xs, 0.95).toFixed(0)} max=${xs[xs.length - 1].toFixed(0)}]`;
    });
    // Event-loop delay shows time the process itself was too busy to answer anyone.
    parts.push(`loop[p95=${(loop.percentile(95) / 1e6).toFixed(0)} max=${(loop.max / 1e6).toFixed(0)}]`);
    console.error(`[timing ${clock}] ${parts.join(' ')}`);
    windowSamples.clear();
    loop.reset();
  }, 2000).unref();
}
