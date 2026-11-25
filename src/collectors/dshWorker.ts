import { createReadStream, promises as fs } from 'fs';
import { Transform } from 'stream';
import { parentPort, workerData } from 'worker_threads';
import { DshContentError, DshParser } from './dshParser';
import { splitLines } from './dshLines';

type Decoder = Transform & { bytesWritten: number };

async function* decodeFrames(file: string, create: () => Decoder): AsyncGenerator<Buffer> {
  const { size } = await fs.stat(file);
  let offset = 0;
  while (offset < size) {
    const input = createReadStream(file, { start: offset });
    const decoded = input.pipe(create());
    input.on('error', err => decoded.destroy(err));
    try {
      for await (const chunk of decoded) yield chunk;
      // Node 22 stops at the first frame; newer runtimes can consume several at once.
      if (decoded.bytesWritten <= 0 || decoded.bytesWritten > size - offset) throw new DshContentError('DSH zstd decoder made invalid progress');
      offset += decoded.bytesWritten;
    } finally { input.destroy(); decoded.destroy(); }
  }
}

async function run() {
  const create = (require('zlib') as { createZstdDecompress?: () => Decoder }).createZstdDecompress;
  if (!create) throw new Error('DSH requires native zstd decompression in this runtime');
  const parser = new DshParser(workerData.revision, workerData.inspect);
  for await (const line of splitLines(decodeFrames(workerData.file, create))) parser.line(line);
  return parser.finish();
}

/** Content failures (a damaged or malformed log) repeat for the same bytes; disk and runtime failures may not. */
const isContentFailure = (error: unknown): boolean =>
  error instanceof DshContentError || /^(Z_|ZSTD_)/.test(String((error as { code?: unknown }).code ?? ''));

void run().then(
  result => parentPort!.postMessage({ result }),
  error => parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error), content: isContentFailure(error) }),
);
