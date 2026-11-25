import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Fence, lostLock, privateDirectory } from './privateFiles';

/** A lock folder touched this recently belongs to a live writer, whatever the process table says. */
const FRESH_MS = 15_000;
/** Past this silence a lock is abandoned even if its recorded process id now belongs to an unrelated process. */
const ABANDONED_MS = 5 * 60_000;
const WAIT_MS = 90_000;
const HEARTBEAT_MS = 5_000;

export interface FileLock {
  release: () => Promise<void>;
  assertHeld: Fence;
}

function processAlive(token?: string): boolean {
  const pid = Number(token?.match(/^(\d+)-/)?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * Waits for the lock on `file`, a folder next to it. `owner` holds `<pid>-<uuid>` and is the only file older releases read; `info`
 * adds the host, so a lock left on a shared drive by another machine is not judged by this machine's process table.
 * Whatever the rules decide, the fence (`assertHeld`) keeps a wrongly reclaimed lock from overwriting anything: a writer checks it
 * before it commits and stages the new file inside the lock folder, so the commit itself fails if the folder was reclaimed meanwhile.
 */
export async function acquireFileLock(file: string, options: { waitMs?: number } = {}): Promise<FileLock> {
  const dir = `${file}.lock`;
  const owner = path.join(dir, 'owner');
  const info = path.join(dir, 'info');
  const token = `${process.pid}-${randomUUID()}`;
  await privateDirectory(path.dirname(dir));
  const readText = (target: string) => fs.readFile(target, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  const readOwner = () => readText(owner);
  const readHost = async (): Promise<unknown> => {
    try { return (JSON.parse(await readText(info) ?? 'null') as { host?: unknown } | null)?.host; }
    catch { return undefined; }
  };
  const ownerGone = async (): Promise<boolean> => {
    const host = await readHost();
    return (host === undefined || host === os.hostname()) && !processAlive(await readOwner());
  };
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    const created = await fs.mkdir(dir, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      return false;
    });
    if (created) {
      try { await fs.writeFile(owner, token, { flag: 'wx', mode: 0o600 }); }
      catch (error) { await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined); throw error; }
      await fs.writeFile(info, JSON.stringify({ host: os.hostname(), acquiredAt: new Date().toISOString() }), { mode: 0o600 }).catch(() => undefined);
      const held = async () => await readOwner() === token;
      const beat = setInterval(() => void held().then(current => {
        if (current) return fs.utimes(dir, new Date(), new Date());
      }).catch(() => undefined), HEARTBEAT_MS);
      beat.unref();
      return {
        release: async () => {
          clearInterval(beat);
          if (await held()) await fs.rm(dir, { recursive: true, force: true });
        },
        assertHeld: Object.assign(async () => {
          if (!(await held())) throw lostLock(file);
        }, { stage: dir }),
      };
    }
    try {
      const seen = await fs.stat(dir);
      const age = Math.abs(Date.now() - seen.mtimeMs);
      if (age > FRESH_MS && (age > ABANDONED_MS || await ownerGone())) {
        const displaced = `${dir}.stale-${token}`;
        await fs.rename(dir, displaced);
        const moved = await fs.stat(displaced);
        if (moved.dev === seen.dev && moved.ino === seen.ino && moved.mtimeMs === seen.mtimeMs) await fs.rm(displaced, { recursive: true, force: true });
        else await fs.rename(displaced, dir).catch(() => fs.rm(displaced, { recursive: true, force: true }));
        continue;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${dir}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
