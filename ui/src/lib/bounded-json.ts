export class BoundedJsonError extends Error { constructor(readonly status: 400 | 413) { super(status === 413 ? 'payload_too_large' : 'invalid_request'); } }

/** Reads a JSON request body with a hard byte cap, enforced on content-length and on the streamed size. Throws BoundedJsonError (400 or 413). */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new BoundedJsonError(400);
  if (Number(request.headers.get('content-length')) > maxBytes) throw new BoundedJsonError(413);
  if (!request.body) throw new BoundedJsonError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new BoundedJsonError(413); }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof BoundedJsonError) throw error;
    throw new BoundedJsonError(400);
  } finally { reader.releaseLock(); }
}
