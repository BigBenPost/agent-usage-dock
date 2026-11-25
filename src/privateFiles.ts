import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

export const privateDirectory = (dir: string) => fs.mkdir(dir, { recursive: true, mode: 0o700 });

export async function tightenOwnedPath(file: string, mode: number): Promise<void> {
  if (!process.getuid) return;
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (stat && (stat.isFile() || stat.isDirectory()) && stat.uid === process.getuid() && (stat.mode & 0o077)) await fs.chmod(file, mode);
}

export async function fileStamp(file: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(file);
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Checks that the writer still holds its lock. `stage` is the lock's own folder: a file staged there can be renamed into place only
 * while the lock folder is where the writer left it, so a lock reclaimed after the last check makes the rename fail instead of
 * letting an old write replace a newer one.
 */
export type Fence = (() => Promise<void>) & { readonly stage?: string };

export const lostLock = (file: string): Error => new Error(`lost the lock on ${file} to another process`);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

async function publishVia(temp: string, file: string, text: string, fence: Fence | undefined, staged: boolean): Promise<void> {
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
      await fence?.();
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  } catch (error) {
    if (staged && errorCode(error) === 'ENOENT') throw lostLock(file);
    throw error;
  }
}

export async function publishPrivateFile(file: string, text: string, fence?: Fence): Promise<void> {
  await privateDirectory(path.dirname(file));
  if (fence?.stage !== undefined) {
    try { return await publishVia(path.join(fence.stage, `${path.basename(file)}.${randomUUID()}.tmp`), file, text, fence, true); }
    catch (error) { if (errorCode(error) !== 'EXDEV') throw error; }
  }
  await publishVia(`${file}.${process.pid}.${randomUUID()}.tmp`, file, text, fence, false);
}

const STALE_AFTER_MS = 3_600_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OWNED_FILE = String.raw`(?:usage(?:-v\d+)?\.json|history-ledger(?:-v\d+)?\.json|cli\.js|dshWorker(?:-\d+\.\d+\.\d+)?\.js|usage-v3-(?:\d{4}-\d{2}-\d{2}|pre-rebuild-[\w.-]+)\.json)`;
const TEMPORARY = new RegExp(String.raw`^${OWNED_FILE}\.\d+(?:\.${UUID})?\.tmp$`);
const DISPLACED_LOCK = new RegExp(String.raw`^(?:usage(?:-v\d+)?\.json|cli\.js)\.lock\.stale-\d+-${UUID}$`);
const swept = new Set<string>();

/**
 * Removes what a crashed writer left behind in `dirs`: its temp files and the lock folders other writers moved aside.
 * Only names this extension creates qualify (the data folder can be shared with other programs), and only once they are over an
 * hour old. A leftover costs disk space, so errors are ignored.
 */
export async function sweepStale(dirs: readonly string[], now = Date.now()): Promise<void> {
  for (const dir of dirs) {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { continue; }
    for (const name of names) {
      const temporary = TEMPORARY.test(name);
      if (!temporary && !DISPLACED_LOCK.test(name)) continue;
      try {
        const target = path.join(dir, name);
        const stat = await fs.lstat(target);
        if (now - stat.mtimeMs <= STALE_AFTER_MS || stat.isDirectory() === temporary) continue;
        await fs.rm(target, { recursive: !temporary, force: true });
      } catch { /* the next process tries again */ }
    }
  }
}

/** `sweepStale` for folders this process has not swept yet, so a long-lived editor does it once. */
export async function sweepOncePerProcess(dirs: readonly string[]): Promise<void> {
  const fresh = dirs.map(dir => path.resolve(dir)).filter(dir => !swept.has(dir));
  for (const dir of fresh) swept.add(dir);
  if (fresh.length) await sweepStale(fresh);
}
