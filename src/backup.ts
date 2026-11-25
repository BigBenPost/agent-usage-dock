import { promises as fs } from 'fs';
import * as path from 'path';
import { DayRecord, SessionRecord, UsageRecord } from './types';
import { isUsageRecord, joinBaseline, LegacyBaseline, splitBaseline } from './reconcile';
import type { StoreData } from './store';
import { isDays, isLegacy, isSessionTotals } from './validation';
import { Fence, privateDirectory, publishPrivateFile, tightenOwnedPath } from './privateFiles';

export const DAILY_KEEP = 7;
export const REBUILD_KEEP = 5;

const DAILY = /^usage-v3-\d{4}-\d{2}-\d{2}\.json$/;
const REBUILD = /^usage-v3-pre-rebuild-.+\.json$/;

/** Where copies of the store at `file` are kept: a folder next to it, so they move with the store. */
export const backupDir = (file: string): string => path.join(path.dirname(file), 'backups');

/** Where permanent historical archives are kept: never pruned. */
export const archiveDir = (file: string): string => path.join(path.dirname(file), 'archive');

export const archiveLedgerFile = (file: string): string => path.join(archiveDir(file), 'history-ledger.json');
export const currentArchiveFile = (file: string): string => path.join(archiveDir(file), 'history-ledger-v3.json');

const exists = (p: string): Promise<boolean> => fs.stat(p).then(() => true, () => false);

/** Copies the store into the backups folder under `name`. Returns the new path; undefined when there is no store or the copy is already there. */
async function copyInto(file: string, name: string): Promise<string | undefined> {
  if (!(await exists(file))) return undefined;
  const dir = backupDir(file);
  const target = path.join(dir, name);
  await privateDirectory(dir);
  await tightenOwnedPath(dir, 0o700);
  if (await exists(target)) { await tightenOwnedPath(target, 0o600); return undefined; }
  // Copied under a temp name first, so a crash cannot leave half a file that then counts as today's backup.
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.copyFile(file, tmp);
    await tightenOwnedPath(tmp, 0o600);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return target;
}

async function prune(file: string, pattern: RegExp, keep: number): Promise<void> {
  const names = (await fs.readdir(backupDir(file))).filter((n) => pattern.test(n)).sort();
  await Promise.all(names.slice(0, Math.max(0, names.length - keep)).map((n) => fs.rm(path.join(backupDir(file), n), { force: true })));
}

/**
 * Keeps the store as it stood before the first write of each UTC day, the newest 7 days. Call with the store lock held
 * and the file just read, so what is copied is a file that parsed.
 */
export async function dailyBackup(file: string, now = Date.now(), keep = DAILY_KEEP): Promise<void> {
  if (await copyInto(file, `usage-v3-${new Date(now).toISOString().slice(0, 10)}.json`)) await prune(file, DAILY, keep);
}

/** Copies the store before a rebuild wipes it, keeping the newest 5 such copies. Returns where the copy went, or undefined when there was nothing to copy. */
export async function rebuildBackup(file: string, now = Date.now(), keep = REBUILD_KEEP): Promise<string | undefined> {
  const copy = await copyInto(file, `usage-v3-pre-rebuild-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`);
  if (copy) await prune(file, REBUILD, keep);
  return copy;
}

export interface ArchiveLedger {
  version: 1 | 2 | 3;
  updatedAt: string;
  days: Record<string, DayRecord>;
  records?: Record<string, UsageRecord>;
  legacy?: LegacyBaseline;
  /** The session totals of the baseline, as they are written; `loadArchive` hands them back inside `legacy`. */
  legacySessions?: Record<string, SessionRecord>;
  hiddenSessions?: string[];
}

/** An archive that cannot be trusted. It is never moved or rewritten automatically; the user decides what to do with it. */
export class InvalidArchiveError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`${file}: ${reason}. The archive was left untouched; see "Recovering a damaged archive" in the README.`);
    this.name = 'InvalidArchiveError';
  }
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function validateArchive(value: unknown, file: string, version: ArchiveLedger['version']): ArchiveLedger {
  if (!object(value) || value.version !== version || !isDays(value.days)) throw new InvalidArchiveError(file, 'invalid archive schema (expected version ' + version + ')');
  if (value.version === 2 || value.version === 3) {
    if (!object(value.records)) throw new InvalidArchiveError(file, 'missing archive records');
    for (const [id, r] of Object.entries(value.records)) {
      if (!isUsageRecord(r, id)) throw new InvalidArchiveError(file, 'invalid archive record');
    }
  }
  if (value.legacy !== undefined && !isLegacy(value.legacy)) throw new InvalidArchiveError(file, 'invalid legacy baseline');
  if (value.legacySessions !== undefined && !isSessionTotals(value.legacySessions)) throw new InvalidArchiveError(file, 'invalid session totals');
  if (value.hiddenSessions !== undefined && (!Array.isArray(value.hiddenSessions) || !value.hiddenSessions.every(x => typeof x === 'string'))) throw new InvalidArchiveError(file, 'invalid hidden sessions');
  const ledger = value as ArchiveLedger;
  if (ledger.legacySessions) {
    ledger.legacy = joinBaseline(ledger.legacy, ledger.legacySessions);
    delete ledger.legacySessions;
  }
  return ledger;
}

async function readArchive(file: string, version: ArchiveLedger['version']): Promise<ArchiveLedger | undefined> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (err) { throw new InvalidArchiveError(file, `not valid JSON (${(err as Error).message})`); }
  return validateArchive(parsed, file, version);
}

export async function loadArchive(file: string, allowLegacy = true): Promise<ArchiveLedger | undefined> {
  const current = await readArchive(currentArchiveFile(file), 3);
  return current ?? (allowLegacy ? await readArchive(path.join(archiveDir(file), 'history-ledger-v2.json'), 2) ?? await readArchive(archiveLedgerFile(file), 1) : undefined);
}

/** Writes the full request snapshot. The caller holds the store lock and has already decided that something changed. */
export async function saveArchive(file: string, data: Pick<StoreData, 'days' | 'records' | 'legacy' | 'hiddenSessions'>, assertHeld: Fence): Promise<void> {
  const ledger: ArchiveLedger = { version: 3, updatedAt: new Date().toISOString(), days: data.days, records: data.records, ...splitBaseline(data.legacy), hiddenSessions: data.hiddenSessions };
  await publishPrivateFile(currentArchiveFile(file), JSON.stringify(ledger), assertHeld);
}
