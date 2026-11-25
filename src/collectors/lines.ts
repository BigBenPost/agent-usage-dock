import { createHash, Hash } from 'crypto';
import { Dirent, promises as fs } from 'fs';
import * as path from 'path';
import { isObject, safeKey } from '../validation';

export interface SkippedLines {
  count: number;
  samples: { offset: number; reason: string }[];
}

export interface FileState {
  parserVersion?: number;
  size: number;
  mtimeMs: number;
  offset: number;
  model?: string;
  fingerprint?: string;
  identity?: string;
  ctimeMs?: number;
  prefixDigest?: string;
  strictRead?: boolean;
  terminalLine?: boolean;
  dbCursor?: number;
  lastFullScan?: number;
  /** Lines or database steps that could not be read and were passed over. Dropped when the file is re-read from its start. */
  skipped?: SkippedLines;
  /** Deterministic content problems of a fingerprinted file, so an unchanged file is not decoded again. */
  problems?: string[];
  /** Optional metadata retained while scanning a file. */
  session?: string;
  project?: string;
  source?: 'claude' | 'codex';
  codexTotal?: number;
  codexTurn?: string;
  codexForkFrom?: string;
  codexForkAt?: number;
}

export type LineHandler = (line: string, state: FileState) => void;

const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_REASON_CHARS = 160;
export const MAX_SKIPPED_SAMPLES = 5;
export const MAX_STATE_PROBLEMS = 10;

export interface LineScanOptions {
  strict?: boolean;
  signal?: AbortSignal;
}

export interface DirScanOptions extends LineScanOptions {
  /** Source name used in the message about skipped lines. */
  label?: string;
}

const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;
export const UNKNOWN_MODEL = 'unknown-model';

/**
 * A model id that is safe to use as an object key and to print. Logs are untrusted input: `__proto__`, `constructor` or a
 * name with newlines or markup must not get through. Anything else becomes `unknown-model`, which shows up as unpriced.
 */
export function safeModel(model: unknown): string {
  return typeof model === 'string' && MODEL_ID.test(model) && safeKey(model) ? model : UNKNOWN_MODEL;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/** 1970-01-01 to 9999-12-31: the range in which an instant has a four-digit year and a valid accounting day. */
export const MAX_TIME_MS = 253402300799999;
const inRange = (t: number): boolean => t >= 0 && t <= MAX_TIME_MS;

export function dayOfMs(t: number): string | undefined {
  return inRange(t) ? new Date(t).toISOString().slice(0, 10) : undefined;
}

export function timestampMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const t = Date.parse(ts);
  return inRange(t) ? t : undefined;
}

export function utcDay(ts: unknown): string | undefined {
  const t = timestampMs(ts);
  return t === undefined ? undefined : dayOfMs(t);
}

/** Last folder of a working-directory path. Full paths are not kept, only enough to recognise the project. */
export function projectName(cwd: unknown): string | undefined {
  return typeof cwd === 'string' ? cwd.split(/[\\/]/).filter(Boolean).pop() : undefined;
}

/** A file or folder that is gone is normal after log pruning. Anything else means usage was not read. */
export const isGone = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
export const describe = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Entries in a fixed order, real ones before symlinks, so a path reachable twice is always listed under its real name. */
export const realFirst = (entries: Dirent[]): Dirent[] => [...entries.filter(e => !e.isSymbolicLink()).sort(byName), ...entries.filter(e => e.isSymbolicLink()).sort(byName)];

/**
 * What a directory entry is once a symlink is followed. A link to nowhere counts as gone; a loop or a refused
 * permission is added to `problems`.
 */
export async function entryKind(dir: string, entry: Dirent, problems: string[]): Promise<'file' | 'directory' | undefined> {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return undefined;
  const link = path.join(dir, entry.name);
  try {
    const stat = await fs.stat(link);
    return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined;
  } catch (err) {
    if (!isGone(err)) problems.push(`cannot follow ${link}: ${describe(err)}`);
    return undefined;
  }
}

/**
 * Lists the `.jsonl` files under `root`, following symlinked folders and files. Real folders are read first and every folder
 * is read once by its real path, so a loop ends and a folder reachable twice is listed under its real name only. A folder that
 * cannot be listed (not because it is gone), a link that cannot be followed and a loop are added to `problems`; a link to
 * nowhere counts as gone.
 */
export async function listJsonl(root: string, problems: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const visited = new Set<string>();
  const listed = new Set<string>();
  const links: { dir: string; real: string; entry: Dirent }[] = [];
  const walk = async (dir: string, real: string): Promise<void> => {
    visited.add(real);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (!isGone(err)) problems.push(`cannot list ${dir}: ${describe(err)}`);
      return;
    }
    for (const e of entries.sort(byName)) {
      if (e.isSymbolicLink()) links.push({ dir, real, entry: e });
      else if (e.isDirectory()) await walk(path.join(dir, e.name), path.join(real, e.name));
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        listed.add(path.join(real, e.name));
        out.push(path.join(dir, e.name));
      }
    }
  };
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch (err) {
    if (!isGone(err)) problems.push(`cannot list ${root}: ${describe(err)}`);
    return out;
  }
  await walk(root, rootReal);
  for (let i = 0; i < links.length; i++) {
    const { dir, real, entry } = links[i];
    const link = path.join(dir, entry.name);
    const kind = await entryKind(dir, entry, problems);
    if (kind === undefined || (kind === 'file' && !entry.name.endsWith('.jsonl'))) continue;
    let target: string;
    try {
      target = await fs.realpath(link);
    } catch (err) {
      if (!isGone(err)) problems.push(`cannot follow ${link}: ${describe(err)}`);
      continue;
    }
    if (kind === 'file') {
      if (!listed.has(target)) {
        listed.add(target);
        out.push(link);
      }
    } else if (!visited.has(target)) {
      await walk(link, target);
    } else if (real === target || real.startsWith(target + path.sep)) {
      problems.push(`symlink loop at ${link}`);
    }
  }
  return out;
}

/** Samples of a persisted skipped list; a state from disk is not trusted to have the right shape. */
export const skippedSamples = (skipped: SkippedLines | undefined): SkippedLines['samples'] => (Array.isArray(skipped?.samples) ? skipped!.samples : []);

const copySkipped = (skipped: SkippedLines): SkippedLines | undefined =>
  Number.isSafeInteger(skipped.count) && Array.isArray(skipped.samples) ? { count: skipped.count, samples: skipped.samples.map(s => ({ ...s })) } : undefined;

const reasonOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) || 'unreadable';

/** One problem line for a file that carries skipped lines (or database steps), or undefined when the state has none. */
export function skippedProblem(label: string, file: string, skipped: SkippedLines | undefined, unit: 'line' | 'step' = 'line'): string | undefined {
  const count = skipped && Number.isSafeInteger(skipped.count) ? skipped.count : 0;
  const first = skippedSamples(skipped)[0];
  if (count < 1 || !first) return undefined;
  const where = `${count === 1 ? '' : 'first at '}${unit === 'line' ? 'byte' : 'step'} ${first.offset}: ${first.reason}`;
  return `${label}: ${count} unreadable ${unit}${count === 1 ? '' : 's'} skipped in ${file} (${where}); later usage is still collected.`;
}

/**
 * Feeds complete lines appended since `prev` to `onLine` and returns the new state.
 * A trailing line without a newline is left for the next call. A shrunken file is re-read from the start.
 * Outside strict mode a line that `onLine` rejects, or that is longer than 32 MiB, is recorded in `skipped` and passed
 * over, so one bad line never blocks the lines after it. In strict mode the first such line fails the read.
 */
export async function readNewLines(file: string, prev: FileState | undefined, onLine: LineHandler, options: LineScanOptions = {}): Promise<FileState> {
  options.signal?.throwIfAborted();
  const verified = prev?.parserVersion === 2 && prev?.prefixDigest && (!options.strict || prev.strictRead);
  if (verified && prev) {
    const stat = await fs.stat(file);
    if (prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.ctimeMs === stat.ctimeMs && prev.identity === `${stat.dev}:${stat.ino}`) return prev;
  }
  const fh = await fs.open(file, 'r');
  try {
    const stat = await fh.stat();
    if (!stat.isFile()) throw new Error('Expected a regular JSONL file');
    const identity = `${stat.dev}:${stat.ino}`;
    const havePrefix = verified && prev?.identity === identity;

    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let digest = createHash('sha256');
    let state: FileState = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, identity, offset: 0 };
    if (havePrefix && prev && stat.size > prev.size && prev.offset <= prev.size && !prev.terminalLine) {
      let pos = 0;
      while (pos < prev.offset) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await fh.read(chunk, 0, Math.min(CHUNK_BYTES, prev.offset - pos), pos);
        if (!bytesRead) throw new Error('JSONL changed while checking its prefix');
        digest.update(chunk.subarray(0, bytesRead));
        pos += bytesRead;
      }
      if (digest.copy().digest('hex') === prev.prefixDigest) {
        state = { ...prev, ...state, offset: prev.offset };
        const carried = prev.skipped && copySkipped(prev.skipped);
        if (carried) state.skipped = carried;
        else delete state.skipped;
      } else digest = createHash('sha256');
    }

    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let discard: { before: Hash; bytes: number } | undefined;
    const skip = (reason: string): void => {
      const skipped = state.skipped ??= { count: 0, samples: [] };
      skipped.count++;
      if (skipped.samples.length < MAX_SKIPPED_SAMPLES) skipped.samples.push({ offset: state.offset, reason });
    };
    const dispatch = (line: Buffer, newline: boolean): void => {
      const length = line.length + pendingBytes;
      if (length > MAX_LINE_BYTES) {
        if (options.strict) throw new Error('JSONL line exceeds 32 MiB');
        for (const part of [...pending, line]) digest.update(part);
        skip('line exceeds 32 MiB');
      } else {
        const bytes = pendingBytes ? Buffer.concat([...pending, line], length) : line;
        const text = bytes.toString('utf8', 0, bytes.length - Number(newline));
        if (options.strict && text.trim()) {
          try { if (!isObject(JSON.parse(text))) throw new Error('Expected an event object'); }
          catch { throw new Error(`Invalid or incomplete JSON at byte ${state.offset}`); }
        }
        try {
          onLine(text, state);
        } catch (err) {
          if (options.strict) throw err;
          skip(reasonOf(err));
        }
        digest.update(bytes);
      }
      state.offset += length;
      pending = [];
      pendingBytes = 0;
    };
    const endDiscard = (lastBytes: number): void => {
      skip('line exceeds 32 MiB');
      state.offset += discard!.bytes + lastBytes;
      discard = undefined;
    };

    let pos = state.offset;
    while (pos < stat.size) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await fh.read(chunk, 0, Math.min(CHUNK_BYTES, stat.size - pos), pos);
      if (bytesRead === 0) throw new Error('JSONL was truncated during collection');
      pos += bytesRead;
      const buf = chunk.subarray(0, bytesRead);
      let start = 0;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, start)) !== -1) {
        if (discard) {
          digest.update(buf.subarray(start, nl + 1));
          endDiscard(nl + 1 - start);
        } else {
          dispatch(buf.subarray(start, nl + 1), true);
        }
        start = nl + 1;
      }
      if (start < bytesRead) {
        if (discard) {
          digest.update(buf.subarray(start));
          discard.bytes += bytesRead - start;
        } else {
          const rest = Buffer.from(buf.subarray(start));
          pendingBytes += rest.length;
          pending.push(rest);
          if (pendingBytes > MAX_LINE_BYTES) {
            if (options.strict) throw new Error('JSONL line exceeds 32 MiB');
            // The line is hashed as it streams past and never buffered; if the file ends inside it, the hash rewinds.
            discard = { before: digest.copy(), bytes: pendingBytes };
            for (const part of pending) digest.update(part);
            pending = [];
            pendingBytes = 0;
          }
        }
      }
    }
    if (discard) digest = discard.before;
    if (options.strict && pendingBytes) {
      dispatch(Buffer.alloc(0), false);
      state.terminalLine = true;
    }
    const after = await fh.stat();
    if (options.strict && (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)) {
      throw new Error('JSONL changed during flush; retry after the writer stops');
    }
    state.parserVersion = 2;
    state.strictRead = options.strict === true;
    state.prefixDigest = digest.digest('hex');
    return state;
  } finally {
    await fh.close();
  }
}

/**
 * Reads new lines from every `.jsonl` under `root`, updating `files` in place. Returns how many file states changed.
 * What could not be read is added to `problems`; those files keep their state, so the next scan tries them again.
 * Lines that were skipped stay reported for as long as the file's state carries them.
 */
export async function scanDir(root: string, files: Record<string, FileState>, onLine: LineHandler, problems: string[] = [], options: DirScanOptions = {}): Promise<number> {
  const before = problems.length;
  const found = await listJsonl(root, problems);
  const live = new Set(found);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  let changed = 0;
  // A folder that failed to list looks empty; its files are not gone, so their states stay.
  if (problems.length === before) {
    for (const key of Object.keys(files)) {
      if (key.startsWith(prefix) && !live.has(key)) {
        delete files[key];
        changed++;
      }
    }
  }
  for (const file of found) {
    const prev = files[file];
    try {
      const next = await readNewLines(file, prev, onLine, options);
      if (next !== prev) {
        files[file] = next;
        changed++;
      }
    } catch (err) {
      if (options.signal?.aborted) throw err;
      // Deleted, or not readable right now; the state is kept and the next poll retries.
      if (!isGone(err)) problems.push(`cannot read ${file}: ${describe(err)}`);
    }
    const skipped = skippedProblem(options.label ?? 'JSONL', file, files[file]?.skipped);
    if (skipped) problems.push(skipped);
  }
  return changed;
}
