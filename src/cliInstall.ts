import { promises as fs } from 'fs';
import * as path from 'path';
import { acquireFileLock } from './fileLock';
import { publishPrivateFile, tightenOwnedPath } from './privateFiles';

// esbuild.mjs puts this line first in every bundle, with the package version.
const STAMP = /^\/\/ (?:ai-(?:token|usage)-monitor|agy-token-tracker|agent-usage-dock) (\d+)\.(\d+)\.(\d+)/;

/** Version stamped on the first line of a built bundle; undefined for builds from before the stamp. */
export function bundleVersion(text: string): [number, number, number] | undefined {
  const m = STAMP.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

const isNewer = (a: number[], b: number[]): boolean => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i !== -1 && a[i] > b[i];
};

const VERSIONED_WORKER = /^dshWorker-(\d+)\.(\d+)\.(\d+)\.js$/;

/** The CLI at the shared path reads only the worker of its own version; the workers of earlier versions are dead weight. */
async function removeOlderWorkers(dir: string, installed: number[]): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.map(async (name) => {
    const m = VERSIONED_WORKER.exec(name);
    if (m && isNewer(installed, [Number(m[1]), Number(m[2]), Number(m[3])])) await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }));
}

/**
 * Puts the bundled CLI at the shared path, unless the copy there is from a newer version: every editor installs its own,
 * and one still running an older extension must not replace the newer CLI. The file is replaced in one rename, since
 * `clear-ai-history` may be running it.
 */
export async function installCli(bundled: string, target: string): Promise<'installed' | 'current' | 'kept newer'> {
  const mine = await fs.readFile(bundled, 'utf8');
  const ours = bundleVersion(mine);
  const read = (file: string) => fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const workerText = await read(path.join(path.dirname(bundled), 'dshWorker.js'));
  const lock = await acquireFileLock(target);
  const dir = path.dirname(target);
  try {
    const there = await read(target);
    const theirs = there === undefined ? undefined : bundleVersion(there);
    if (theirs && ours && isNewer(theirs, ours)) {
      await removeOlderWorkers(dir, theirs);
      return 'kept newer';
    }
    if (workerText !== undefined) {
      const to = path.join(dir, ours ? `dshWorker-${ours.join('.')}.js` : 'dshWorker.js');
      if (await read(to) !== workerText) await publishPrivateFile(to, workerText, lock.assertHeld);
      else await tightenOwnedPath(to, 0o600);
    }
    if (there === mine) await tightenOwnedPath(target, 0o600);
    else await publishPrivateFile(target, mine, lock.assertHeld);
    if (ours) await removeOlderWorkers(dir, ours);
    return there === mine ? 'current' : 'installed';
  } finally {
    await lock.release();
  }
}
