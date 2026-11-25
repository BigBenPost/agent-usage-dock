import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after } from 'node:test';

export async function temporaryDirectory(prefix: string): Promise<string> {
  if (!prefix || path.basename(prefix) !== prefix) throw new Error('temporary directory prefix must be a plain name');
  const directory = await fs.mkdtemp(path.join(process.env.USAGE_MONITOR_TEST_TMP_ROOT ?? os.tmpdir(), prefix));
  after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));
  return directory;
}
