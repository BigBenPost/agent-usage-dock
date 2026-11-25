import { DshContentError } from './dshParser';

const MAX_LINE_BYTES = 32 * 1024 * 1024;

const lineText = (parts: Buffer[], length: number): string => {
  const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
  return bytes.toString('utf8', 0, bytes[length - 1] === 0x0d ? length - 1 : length);
};

/**
 * Splits decoded bytes into lines on `\n` only and drops one trailing `\r`. U+2028, U+2029 and U+0085 are ordinary
 * characters inside a JSON string, so a general-purpose line reader (which breaks on them in newer Node versions) must not
 * be used here.
 */
export async function* splitLines(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const chunk of chunks) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf(0x0a, start)) !== -1) {
      const length = pendingBytes + nl - start;
      if (length > MAX_LINE_BYTES) throw new DshContentError('DSH log line exceeds 32 MiB');
      yield lineText([...pending, buf.subarray(start, nl)], length);
      pending = [];
      pendingBytes = 0;
      start = nl + 1;
    }
    if (start < buf.length) {
      pending.push(Buffer.from(buf.subarray(start)));
      pendingBytes += buf.length - start;
      if (pendingBytes > MAX_LINE_BYTES) throw new DshContentError('DSH log line exceeds 32 MiB');
    }
  }
  if (pendingBytes) yield lineText(pending, pendingBytes);
}
