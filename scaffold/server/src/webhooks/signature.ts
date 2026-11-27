import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_SKEW_SECONDS = 300; // "more than five minutes old" is rejected

export type SignatureResult = 'ok' | 'bad' | 'stale';

// Parses `t=<unix seconds>,v1=<hex>` without ever throwing. Anything that does
// not look exactly like that is "bad", and the caller answers 401 (never 5xx).
function parseHeader(header: string | undefined): { t: string; v1: Buffer[] } | null {
  if (!header || header.length > 512) return null;
  let t: string | null = null;
  const v1: Buffer[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) return null;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') {
      if (t !== null || !/^\d{1,12}$/.test(value)) return null;
      t = value;
    } else if (key === 'v1') {
      // Fixed length, so timingSafeEqual below can never throw on a length mismatch.
      if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
      v1.push(Buffer.from(value, 'hex'));
    }
  }
  if (t === null || v1.length === 0) return null;
  return { t, v1 };
}

export function sign(secret: string, t: number | string, raw: Buffer | string): string {
  return createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
}

// The MAC is over the RAW request bytes, so the caller must not hand us a
// re-serialised JSON body.
export function verifySignature(
  header: string | undefined,
  raw: Buffer,
  secret: string,
  nowSeconds: number,
): SignatureResult {
  const parsed = parseHeader(header);
  if (!parsed) return 'bad';
  const expected = Buffer.from(sign(secret, parsed.t, raw), 'hex');
  const match = parsed.v1.some((candidate) => timingSafeEqual(candidate, expected));
  if (!match) return 'bad';
  // Checked only after the MAC matches. Up to and including 300 s is genuine.
  if (Math.abs(nowSeconds - Number(parsed.t)) > MAX_SKEW_SECONDS) return 'stale';
  return 'ok';
}
