import { NextResponse } from 'next/server';
import { issueNonce } from '@/lib/auth-nonce-store';
import { rateLimitKeyIp } from '@/lib/client-ip';
import { consumeRateLimit, type RateLimitConfig } from '@/lib/login-rate-limit';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
const NONCE_RATE_LIMIT: RateLimitConfig = { maxAttempts: 120, lockoutMs: 60 * 1000 };

const MAX_BODY_BYTES = 256;
/** Read at most MAX_BODY_BYTES from the stream (cancelling beyond that); null on any problem. */
async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; } finally { reader.releaseLock(); }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const limit = await consumeRateLimit('auth-nonce', rateLimitKeyIp(request), NONCE_RATE_LIMIT);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...headers, 'Retry-After': String(Math.ceil((limit.retryAfterMs ?? 60000) / 1000)) } });
    }
    const body = await boundedJson(request);
    const purpose = typeof body === 'object' && body !== null ? (body as { purpose?: unknown }).purpose : undefined;
    if (purpose !== 'session' && purpose !== 'relay') return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers });
    return NextResponse.json(await issueNonce(purpose), { headers });
  } catch {
    return NextResponse.json({ error: 'unavailable' }, { status: 503, headers });
  }
}
