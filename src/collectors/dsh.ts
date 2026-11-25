import { Dirent, existsSync, promises as fs } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { describe, FileState, MAX_STATE_PROBLEMS, realFirst } from './lines';
import { DSH_PARSER_VERSION, DshResult } from './dshParser';
import { isUsageRecord } from '../reconcile';
import { UsageRecord } from '../types';

declare const __DOCK_BUNDLE_VERSION__: string | undefined;

const insideRoot = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
};

function dshWorkerFile(): string {
  const versioned = typeof __DOCK_BUNDLE_VERSION__ === 'string' && path.join(__dirname, `dshWorker-${__DOCK_BUNDLE_VERSION__}.js`);
  return versioned && existsSync(versioned) ? versioned : path.join(__dirname, 'dshWorker.js');
}

/** The log itself is unreadable (damaged, truncated or malformed), so reading it again will fail the same way. */
export class DshContentFailure extends Error {}

export async function readDsh(file: string, revision: number, signal?: AbortSignal, inspect = false): Promise<DshResult> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(dshWorkerFile(), { workerData: { file, revision, inspect }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const abort = () => finish(new Error('DSH scan cancelled'));
    const timer = setTimeout(() => finish(new Error('DSH scan exceeded 60 seconds')), 60_000);
    const finish = (error?: Error, value?: DshResult) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => error ? reject(error) : resolve(value!), reject);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => finish(message.error ? new (message.content ? DshContentFailure : Error)(message.error) : undefined, message.result));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!settled) finish(new Error('DSH worker exited before returning: ' + code)); });
  });
}

/**
 * Select the highest canonical generation per directory, never fall back from a future one. A folder that cannot be listed (other
 * than because it is gone) is added to `problems` and `unreadable`, and the rest of the tree is still read. Links may point
 * only inside the real sessions root. Real entries are visited before links; every real folder and log is visited once.
 */
export async function discoverDsh(home: string, problems: string[] = [], unreadable: string[] = []): Promise<string[]> {
  const found: string[] = [];
  const start = path.join(home, 'sessions');
  let root: string;
  try { root = await fs.realpath(start); }
  catch (err) {
    // A missing default sessions directory is normal; a dangling root link is not a complete scan.
    const link = await fs.lstat(start).then(s => s.isSymbolicLink(), () => false);
    if (link || (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`cannot list ${start}: ${describe(err)}`); unreadable.push(start);
    }
    return found;
  }
  const visited = new Set<string>();
  const listed = new Set<string>();
  const links: { dir: string; entry: Dirent; ancestors: Set<string> }[] = [];
  const generation = /^session\.v\d+\.jsonl\.zstd$/;
  const reject = (file: string, reason: string) => {
    problems.push(`cannot read ${file}: ${reason}`);
    unreadable.push(generation.test(path.basename(file)) ? path.dirname(file) : file);
  };
  const highest = (entries: Dirent[]) => entries.filter(e => (e.isFile() || e.isSymbolicLink()) && generation.test(e.name))
    .sort((a, b) => Number(b.name.split('.')[1].slice(1)) - Number(a.name.split('.')[1].slice(1)))[0]?.name;
  const add = (file: string, real: string) => { if (!listed.has(real)) { listed.add(real); found.push(file); } };
  const walk = async (dir: string, real: string, ancestors: Set<string>): Promise<void> => {
    if (ancestors.has(real)) { reject(dir, 'symlink loop'); return; }
    if (visited.has(real)) return;
    visited.add(real);
    const parents = new Set([...ancestors, real]);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      problems.push(`cannot list ${dir}: ${describe(err)}`);
      unreadable.push(dir);
      return;
    }
    const selected = highest(entries);
    for (const e of realFirst(entries)) {
      const file = path.join(dir, e.name);
      if (e.isSymbolicLink()) links.push({ dir, entry: e, ancestors: parents });
      else if (e.isDirectory()) await walk(file, path.join(real, e.name), parents);
      else if (e.isFile() && e.name === selected) add(file, path.join(real, e.name));
    }
  };
  await walk(start, root, new Set());
  for (let i = 0; i < links.length; i++) {
    const { dir, entry, ancestors } = links[i];
    const file = path.join(dir, entry.name);
    try {
      const actual = await fs.realpath(file);
      if (!insideRoot(root, actual)) { reject(file, 'symlink target outside the sessions root'); continue; }
      const stat = await fs.stat(file);
      if (stat.isDirectory()) await walk(file, actual, ancestors);
      else if (stat.isFile()) {
        // An alias of v4 cannot bypass a newer generation beside its physical target.
        if (generation.test(path.basename(actual)) && highest(await fs.readdir(path.dirname(actual), { withFileTypes: true })) !== path.basename(actual)) {
          reject(file, 'a higher DSH log generation exists beside the target'); continue;
        }
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entry.name === highest(entries)) add(file, actual);
      }
    } catch (err) { reject(file, describe(err)); }
  }
  return found.sort();
}

const MAX_PROBLEM_CHARS = 300;

/** Distinct problems with how often each repeated, at most MAX_STATE_PROBLEMS lines. */
function summarizeProblems(problems: string[]): string[] {
  const counts = new Map<string, number>();
  for (const problem of problems) {
    const text = problem.slice(0, MAX_PROBLEM_CHARS);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const lines = [...counts].map(([problem, count]) => (count > 1 ? `${problem} (${count} times)` : problem));
  return lines.length > MAX_STATE_PROBLEMS ? [...lines.slice(0, MAX_STATE_PROBLEMS - 1), `and ${lines.length - MAX_STATE_PROBLEMS + 1} more`] : lines;
}

/**
 * Reads every DSH session log whose fingerprint changed. A log with content problems is stored with its fingerprint and
 * problem list, so while it stays unchanged it is not decoded again and the problems are reported from the state. A failure
 * that is not about the content (timeout, cancellation, a crashed worker, a file that changed during the scan, a log
 * generation this version does not know) stores nothing and is retried on the next scan.
 */
export async function scanDsh(home: string, files: Record<string, FileState>, signal?: AbortSignal, read: typeof readDsh = readDsh) {
  const problems: string[] = [], records: UsageRecord[] = [];
  let changedFiles = 0;
  const unreadable: string[] = [];
  const found = await discoverDsh(home, problems, unreadable);
  const root = await fs.realpath(path.join(home, 'sessions')).catch(() => undefined);
  // An unsupported highest generation does not prove an older cursor's file is gone.
  for (const file of found) if (path.basename(file) !== 'session.v4.jsonl.zstd') unreadable.push(path.dirname(file));
  const live = new Set(found);
  const hidden = (key: string) => unreadable.some(dir => key === dir || key.startsWith(dir + path.sep));
  for (const key of Object.keys(files)) if (key.startsWith(path.join(home, 'sessions') + path.sep) && !live.has(key) && !hidden(key)) { delete files[key]; changedFiles++; }
  for (const file of found) {
    signal?.throwIfAborted();
    try {
      if (path.basename(file) !== 'session.v4.jsonl.zstd') throw new Error('Unsupported highest DSH log generation');
      const actual = await fs.realpath(file);
      if (!root || !insideRoot(root, actual)) throw new Error('DSH log target outside the sessions root');
      const stat = await fs.stat(actual);
      const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, DSH_PARSER_VERSION].join(':');
      const known = files[file];
      if (known?.fingerprint === fingerprint) {
        if (Array.isArray(known.problems)) problems.push(...known.problems.filter(p => typeof p === 'string').map(p => file + ': ' + p));
        continue;
      }
      let result: DshResult | undefined;
      const own: string[] = [];
      try {
        result = await read(actual, Math.max(stat.mtimeMs, stat.ctimeMs), signal);
      } catch (err) {
        if (!(err instanceof DshContentFailure)) throw err;
        own.push(err.message);
      }
      const after = await fs.stat(file);
      if (await fs.realpath(file) !== actual || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || stat.ino !== after.ino) throw new Error('DSH file changed during scan; retrying later');
      let invalid = 0;
      for (const record of result?.records ?? []) {
        if (isUsageRecord(record, record.id)) records.push(record);
        else invalid++;
      }
      own.push(...(result?.problems ?? []));
      if (invalid) own.push(`${invalid} usage record${invalid === 1 ? '' : 's'} failed validation and ${invalid === 1 ? 'was' : 'were'} skipped`);
      const stored = summarizeProblems(own);
      const session = result?.session ?? known?.session;
      files[file] = { size: stat.size, offset: 0, mtimeMs: stat.mtimeMs, fingerprint, ...(session ? { session } : {}), ...(stored.length ? { problems: stored } : {}) };
      problems.push(...stored.map(p => file + ': ' + p));
      changedFiles++;
    } catch (err) {
      if (signal?.aborted) throw err;
      problems.push(file + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { records, problems, changedFiles };
}

export interface RecordedDshSession {
  file: string;
  revision: string;
  title?: string;
  firstPrompt?: string;
}

export async function recordedDshSession(files: Record<string, FileState>, id: string, home: string, cached?: RecordedDshSession, signal?: AbortSignal): Promise<RecordedDshSession | undefined> {
  const root = await fs.realpath(path.join(home, 'sessions')).catch(() => undefined);
  if (!root) return undefined;
  for (const [file, state] of Object.entries(files)) {
    if (state.session !== id || !file.startsWith(path.join(home, 'sessions') + path.sep)) continue;
    const actual = await fs.realpath(file).catch(() => undefined);
    if (!actual || !insideRoot(root, actual)) continue;
    const names = [...await fs.readdir(path.dirname(actual)), ...await fs.readdir(path.dirname(file))];
    if (names.some(n => /^session\.v\d+\.jsonl\.zstd$/.test(n) && Number(n.split('.')[1].slice(1)) > 4)) continue;
    const stat = await fs.stat(actual);
    if (!stat.isFile()) continue;
    const revision = [stat.dev, stat.ino, stat.size, stat.ctimeMs, stat.mtimeMs].join(':');
    if (cached?.file === actual && cached.revision === revision) return cached;
    const result = await readDsh(actual, stat.mtimeMs, signal, true);
    if (result.session === id) return { file: actual, revision, title: result.title, firstPrompt: result.firstPrompt };
  }
  return undefined;
}
