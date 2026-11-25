/** Decode with backpressure and a ceiling on retained output, even if the encoded size is tiny. */
export async function gunzipBounded(input: Uint8Array, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      // A decompressor can expand a whole input write before its consumer runs.
      const slice = input.slice(offset, offset + 4096);
      offset += slice.length;
      controller.enqueue(slice);
      if (offset === input.length) controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new RangeError('Gzip output exceeds the size limit');
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(length);
  let written = 0;
  for (const part of parts) {
    bytes.set(part, written);
    written += part.length;
  }
  return bytes;
}
