import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tightenOwnedPath } from './privateFiles';

export const ANTIGRAVITY_HOME = process.env.ANTIGRAVITY_HOME
  || (process.env.HOME ? path.join(process.env.HOME, '.gemini', 'antigravity') : path.join(os.homedir(), '.gemini', 'antigravity'));
export const ANTIGRAVITY_BRAIN_ROOT = path.join(ANTIGRAVITY_HOME, 'brain');
export const ANTIGRAVITY_CONVERSATIONS_ROOT = path.join(ANTIGRAVITY_HOME, 'conversations');
export const ANTIGRAVITY_DB_PATH = path.join(ANTIGRAVITY_HOME, 'conversation_summaries.db');

/** Folder shared by every editor and the CLI, so history survives log deletion and does not depend on which editor was open. */
export function sharedDir(): string {
  return process.env.AGY_TOKEN_TRACKER_HOME
    || process.env.AGY_TOKEN_MONITOR_HOME
    || path.join(os.homedir(), '.agy-token-tracker');
}

export const sharedStoreFile = (): string => path.join(sharedDir(), 'usage-v3.json');
export const sharedCliFile = (): string => path.join(sharedDir(), 'cli.js');

const resolveHome = (dir: string): string => path.resolve(dir.replace(/^~(?=$|[\\/])/, os.homedir()));

/** Resolve one data root for collection and session inspection. */
export function dataPaths(configured?: string): { home: string; brain: string; db: string; conversations: string } {
  const home = resolveHome(configured || ANTIGRAVITY_HOME);
  return { home, brain: path.join(home, 'brain'), db: path.join(home, 'conversation_summaries.db'), conversations: path.join(home, 'conversations') };
}

export function dshHome(configured?: string): string {
  return resolveHome(configured || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

export function claudeHome(configured?: string): string {
  return resolveHome(configured || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export function codexHome(configured?: string): string {
  return resolveHome(configured || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

export function claudeProjects(home = claudeHome()): string {
  return path.join(home, 'projects');
}

export function codexLogRoots(home = codexHome()): string[] {
  return ['sessions', 'archived_sessions'].map(dir => path.join(home, dir));
}

export async function migrateLegacyStore(): Promise<boolean> {
  const target = sharedStoreFile();
  if (!process.env.AGY_TOKEN_TRACKER_HOME && !process.env.AGY_TOKEN_MONITOR_HOME) await tightenOwnedPath(sharedDir(), 0o700);
  const { UsageStore } = await import('./store');
  const store = await UsageStore.load(target); // Never mask a corrupt or future v3 with older data.
  let migrated = false;
  await store.transaction(async () => {
    try { await fs.access(target); return; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    for (const dir of [sharedDir(), path.join(os.homedir(), '.agy-token-monitor')]) {
      for (const name of ['usage-v2.json', 'usage.json']) {
        const source = path.join(dir, name);
        try {
          const prior = await UsageStore.load(source);
          await fs.access(source);
          store.data = prior.data;
          await prior.restoreArchivedDays();
          store.data = prior.data;
          store.markDirty();
          migrated = true;
          return;
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      }
    }
    // An archive may be all that survived a prior installation.
    if (await store.restoreArchivedDays()) { store.markDirty(); migrated = true; }
  });
  return migrated;
}

/** Recover only the current working file; a failed legacy migration must remain visible. */
export async function initializeUsageStore(report: (aside: string) => void) {
  const { InvalidStoreError, UsageStore } = await import('./store');
  const file = sharedStoreFile();
  try { await migrateLegacyStore(); }
  catch (error) {
    if (!(error instanceof InvalidStoreError) || path.resolve(error.file) !== path.resolve(file)) throw error;
  }
  return UsageStore.recover(file, report);
}
