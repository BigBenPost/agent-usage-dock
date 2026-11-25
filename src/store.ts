import { promises as fs } from 'fs';
import * as path from 'path';
import { archiveDir, backupDir, currentArchiveFile, dailyBackup, loadArchive, saveArchive } from './backup';
import { acquireFileLock } from './fileLock';
import { Fence, fileStamp, publishPrivateFile, sweepOncePerProcess, tightenOwnedPath } from './privateFiles';
import { aggregate, canonicalRecords, isUsageRecord, joinBaseline, LegacyBaseline, mergeLegacy, preferredRecord, sameAccounting, splitBaseline, usageRecordProblem } from './reconcile';
import { cursorRecords, CursorMatcher, isCursorLedger } from './cursorLedger';
import { isByModel, isDay, isDays, isLegacy, isSessionTotal, isSessionTotals } from './validation';
import { FileState, safeModel } from './collectors/lines';
import { DayRecord, SessionRecord, Source, UsageRecord } from './types';

export interface StoreData {
  version: 3;
  records: Record<string, UsageRecord>;
  /** In memory the session totals of the baseline are part of it; on disk they are beside it, as `legacySessions`. */
  legacy?: LegacyBaseline;
  /** Sessions an earlier release removed from the session list. Their usage stays in the day totals. */
  hiddenSessions?: string[];
  health?: { root: string; attemptedAt: string; succeededAt?: string; problems: string[] };
  sourceHealth?: Partial<Record<Source, { root: string; status: 'disabled' | 'not-found' | 'ok' | 'incomplete'; attemptedAt: string; succeededAt?: string; problems: string[] }>>;
  codexProblems?: string[];
  firstDay?: string;
  days: Record<string, DayRecord>;
  /** Per-session totals keyed `<source>:<session id>`, derived from the records. */
  sessions?: Record<string, SessionRecord>;
  files: Record<string, FileState>;
}

function emptyData(): StoreData {
  return { version: 3, records: {}, days: {}, sessions: {}, files: {} };
}

/** A file that parsed (or failed to) but is not a usage store. A SyntaxError, so a store that cannot be read is treated alike however it is broken. */
export class InvalidStoreError extends SyntaxError {
  constructor(readonly file: string, message: string) {
    super(`${file}: ${message}`);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStamp = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isHealth = (v: unknown): boolean => isRecord(v) && typeof v.root === 'string' && isStamp(v.attemptedAt) && (v.succeededAt === undefined || isStamp(v.succeededAt))
  && Array.isArray(v.problems) && v.problems.every(p => typeof p === 'string');
const everyValue = (v: unknown, ok: (x: unknown) => boolean): boolean => isRecord(v) && Object.values(v).every(ok);

// Each part of the file, and how to tell it holds what the code indexes into. JSON.stringify drops properties of an array, so `days: []` would swallow usage.
const SHAPES: [key: keyof StoreData | 'legacySessions', required: boolean, ok: (v: unknown) => boolean][] = [
  ['days', true, isDays],
  ['sessions', false, (v) => everyValue(v, (s) => isRecord(s) && everyValue(s.days, isByModel))],
  ['files', false, (v) => everyValue(v, isRecord)],
  ['legacySessions', false, isSessionTotals],
  ['sourceHealth', false, (v) => everyValue(v, h => isRecord(h) && typeof h.root === 'string' && ['disabled', 'not-found', 'ok', 'incomplete'].includes(h.status as string) && Array.isArray(h.problems) && h.problems.every(p => typeof p === 'string'))],
];

/** Parses a store file's text, or throws an InvalidStoreError saying which part is wrong. */
export function parseStoreData(text: string, file: string): StoreData {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new InvalidStoreError(file, `not valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(data)) throw new InvalidStoreError(file, 'does not hold a usage store');
  if (isCursorLedger(data)) {
    try { data = { version: 3, records: Object.fromEntries(cursorRecords(data).map((rec) => [rec.id, rec])), days: {}, files: {} }; }
    catch (err) { throw new InvalidStoreError(file, `not a usage ledger of Cursor: ${(err as Error).message}`); }
  }
  if (!isRecord(data)) throw new InvalidStoreError(file, 'does not hold a usage store');
  if (data.version !== undefined && data.version !== 1 && data.version !== 2 && data.version !== 3) throw new Error(file + ': unsupported store version ' + data.version);
  for (const [key, required, ok] of SHAPES) {
    if ((required || data[key] !== undefined) && !ok(data[key])) throw new InvalidStoreError(file, `"${key}" is missing or malformed`);
  }
  // The last scan's report is not accounting: one that cannot be read is dropped and the next scan writes a new one.
  if (data.health !== undefined && !isHealth(data.health)) delete data.health;
  if (data.version === 2 || data.version === 3) {
    if (!isRecord(data.records)) throw new InvalidStoreError(file, 'missing request ledger');
    for (const [id, rec] of Object.entries(data.records)) {
      if (!isUsageRecord(rec, id)) throw new InvalidStoreError(file, 'malformed request');
    }
  } else {
    const baseline: Record<string, unknown> = { days: structuredClone(data.days), before: Date.now() };
    // The totals are what the old store counted. Its sessions are a view of them: an entry that does not fit is left out rather than refusing the totals.
    const sessions = Object.entries(isRecord(data.sessions) ? data.sessions : {}).filter(([key, session]) => isSessionTotal(key, session));
    if (sessions.length) baseline.sessions = structuredClone(Object.fromEntries(sessions));
    data.legacy = baseline;
    data.records = {};
    data.version = 3;
    data.files = {};
  }
  if (data.legacy !== undefined && !isLegacy(data.legacy)) throw new InvalidStoreError(file, 'malformed legacy baseline');
  if (data.legacySessions !== undefined) {
    data.legacy = joinBaseline(data.legacy as LegacyBaseline | undefined, data.legacySessions as Record<string, SessionRecord>);
    delete data.legacySessions;
  }
  if (data.hiddenSessions !== undefined && (!Array.isArray(data.hiddenSessions) || !data.hiddenSessions.every(x => typeof x === 'string'))) throw new InvalidStoreError(file, 'malformed hidden sessions');
  data.version = 3;
  const codexProblems: string[] = [];
  data.records = canonicalRecords(data.records as Record<string, UsageRecord>, codexProblems);
  if (codexProblems.length) data.codexProblems = codexProblems;
  else delete data.codexProblems;
  const savedFirst = data.firstDay;
  Object.assign(data, aggregate(data.records as Record<string, UsageRecord>, data.legacy as LegacyBaseline | undefined, data.hiddenSessions as string[] | undefined, true));
  data.firstDay ??= typeof savedFirst === 'string' && isDay(savedFirst) ? savedFirst : undefined;
  if (data.firstDay === undefined) delete data.firstDay;
  delete data.seen;
  delete data.open;
  data.files ??= {};
  return data as unknown as StoreData;
}

/** Merge durable facts and their legacy provenance before deriving totals. */
export function mergeData(base: StoreData, other: StoreData): StoreData {
  const out = emptyData();
  out.records = { ...base.records };
  const cursor = new CursorMatcher(out.records);
  // Attribute known sessions before anonymous copies can consume their matching slots.
  for (const rec of Object.values(other.records ?? {}).sort((a, b) => Number(!a.session) - Number(!b.session))) {
    const id = rec.source === 'cursor' ? cursor.slot(rec) : rec.id;
    const placed = id === rec.id ? rec : { ...rec, id };
    out.records[id] = out.records[id] ? preferredRecord(out.records[id], placed) : placed;
  }
  const codexProblems: string[] = [];
  out.records = canonicalRecords(out.records, codexProblems);
  if (codexProblems.length) out.codexProblems = codexProblems;
  out.legacy = mergeLegacy(base.legacy, other.legacy);
  out.files = { ...(base.files ?? {}) };
  if (base.health) out.health = base.health;
  if (base.sourceHealth) out.sourceHealth = base.sourceHealth;
  const hidden = [...new Set([...(base.hiddenSessions ?? []), ...(other.hiddenSessions ?? [])])];
  if (hidden.length) out.hiddenSessions = hidden;
  Object.assign(out, aggregate(out.records, out.legacy, out.hiddenSessions, true));
  return out;
}


/** Every request this machine has read, with the day and session totals derived from them and the cursors that make polling incremental. */
export class UsageStore {
  private dirty = false;
  private batching = false;
  private assertHeld?: Fence;
  private verified?: { working?: string; archive?: string };
  private archived?: { records: StoreData['records']; legacy: StoreData['legacy']; hidden: StoreData['hiddenSessions'] };
  private savedAttempt?: string;
  private rejectedRecords: { id: string; reason: string }[] = [];

  private constructor(private readonly file: string, public data: StoreData) {}

  /** The records the last `addRecords` call refused, with why. Cleared by the next call. */
  get rejected(): readonly { id: string; reason: string }[] { return this.rejectedRecords; }

  static async load(file: string): Promise<UsageStore> {
    try {
      return new UsageStore(file, parseStoreData(await fs.readFile(file, 'utf8'), file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return new UsageStore(file, emptyData());
    }
  }

  static async recover(file: string, report: (aside: string) => void): Promise<UsageStore> {
    const store = new UsageStore(file, emptyData());
    const lock = await acquireFileLock(file);
    try {
      await sweepOncePerProcess(UsageStore.folders(file));
      try { await store.reload(); }
      catch (err) {
        if (!(err instanceof InvalidStoreError)) throw err;
        // Validate recovery before moving anything; never downgrade damaged v3 to a legacy archive.
        if (!(await loadArchive(file, false))) throw err;
        const aside = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
        await tightenOwnedPath(file, 0o600);
        await lock.assertHeld();
        await fs.rename(file, aside);
        report(aside);
      }
      await store.restoreArchivedDays();
      await store.save(lock.assertHeld);
      return store;
    } finally { await lock.release(); }
  }

  private static folders(file: string): string[] {
    return [path.dirname(file), archiveDir(file), backupDir(file)];
  }

  /**
   * Runs `fn` with the file locked and `data` freshly read from it, then saves. Lets editors and the CLI share one file.
   * `fn` gets a `checkpoint` that saves what it has so far and throws if that fails, for a step that cannot be undone and must not run ahead of the saved state.
   */
  async transaction<T>(fn: (checkpoint: () => Promise<void>) => Promise<T> | T, reuseVerified = false): Promise<T> {
    const lock = await acquireFileLock(this.file);
    try {
      this.assertHeld = lock.assertHeld;
      await sweepOncePerProcess(UsageStore.folders(this.file));
      const current = reuseVerified ? await this.snapshotStamp() : undefined;
      const unchanged = current && this.verified && !this.dirty
        && current.working === this.verified.working && current.archive === this.verified.archive;
      this.verified = undefined;
      if (!unchanged) {
        this.archived = undefined;
        await this.reload();
        await this.restoreArchivedDays();
      }
      // A backup that cannot be made must not stop usage from being read.
      await dailyBackup(this.file).catch(() => undefined);
      const result = await fn(() => this.save(lock.assertHeld));
      await this.save(lock.assertHeld);
      if (reuseVerified && this.archiveMatches()) this.verified = await this.snapshotStamp();
      return result;
    } finally {
      this.assertHeld = undefined;
      await lock.release();
    }
  }

  async reload(): Promise<void> {
    if (path.basename(this.file) === 'usage-v3.json') await tightenOwnedPath(this.file, 0o600);
    this.data = (await UsageStore.load(this.file)).data;
    this.dirty = false;
    this.savedAttempt = this.data.health?.attemptedAt;
  }

  get checkpointedAttempt(): string | undefined { return this.savedAttempt; }

  private async snapshotStamp() {
    const [working, archive] = await Promise.all([fileStamp(this.file), fileStamp(currentArchiveFile(this.file))]);
    return { working, archive };
  }

  /** Folds another store file into this one inside a transaction. Returns false if the file does not exist. */
  async absorb(file: string): Promise<boolean> {
    let other: StoreData;
    try {
      other = parseStoreData(await fs.readFile(file, 'utf8'), file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    await this.transaction(async (checkpoint) => {
      this.data = mergeData(this.data, other);
      this.dirty = true;
      await checkpoint();
      await this.archive();
    });
    return true;
  }

  /** Upserts a durable request using the shared reconciliation policy. Throws for a record that fails validation. */
  add(rec: UsageRecord): boolean {
    rec = UsageStore.normalized(rec);
    const problem = usageRecordProblem(rec, rec?.id);
    if (problem) throw new Error(`Invalid usage record: ${problem}`);
    const records = this.data.records, dirty = this.dirty;
    this.data.records = { ...records };
    try {
      const changed = this.upsert(rec);
      if (!changed) { Object.assign(records, this.data.records); this.data.records = records; }
      return changed;
    }
    catch (error) { this.data.records = records; this.dirty = dirty; throw error; }
  }

  /** Returns how many records changed what is counted. A newer revision of identical facts is kept in memory and saved with the next save, but is not a change. */
  addRecords(records: Iterable<UsageRecord>): number {
    const rejected: { id: string; reason: string }[] = [];
    this.rejectedRecords = rejected;
    let changed = 0;
    const priorRecords = this.data.records, priorDirty = this.dirty;
    this.data.records = { ...priorRecords };
    this.batching = true;
    try {
      for (const raw of records) {
        const rec = UsageStore.normalized(raw);
        const problem = usageRecordProblem(rec, rec?.id);
        if (problem) rejected.push({ id: typeof rec?.id === 'string' ? rec.id : '', reason: problem });
        else if (this.upsert(rec)) changed++;
      }
      if (changed) this.reaggregate();
      else { Object.assign(priorRecords, this.data.records); this.data.records = priorRecords; }
    } catch (error) {
      this.data.records = priorRecords;
      this.dirty = priorDirty;
      throw error;
    } finally { this.batching = false; }
    return changed;
  }

  private static normalized(rec: UsageRecord): UsageRecord {
    return rec && typeof rec === 'object' && safeModel(rec.model) !== rec.model ? { ...rec, model: safeModel(rec.model) } : rec;
  }

  private upsert(rec: UsageRecord): boolean {
    const prior = this.data.records[rec.id];
    const next = prior ? preferredRecord(prior, rec) : rec;
    if (prior && sameAccounting(prior, next)) {
      if (next !== prior) this.data.records[rec.id] = structuredClone(next);
      return false;
    }
    this.data.records[rec.id] = structuredClone(next);
    if (!this.batching) this.reaggregate();
    this.dirty = true;
    return true;
  }

  private reaggregate(): void {
    const codexProblems: string[] = [];
    const records = canonicalRecords(this.data.records, codexProblems);
    const totals = aggregate(records, this.data.legacy, this.data.hiddenSessions, true);
    this.data.records = records;
    if (codexProblems.length) this.data.codexProblems = codexProblems;
    else delete this.data.codexProblems;
    Object.assign(this.data, totals);
  }

  markDirty(): void {
    this.dirty = true;
  }

  /**
   * Restores history from the permanent archive into this store's data, and notes whether the archive already says what the
   * store says, so `archive()` can skip the write. Returns how many days or models were backfilled.
   */
  async restoreArchivedDays(): Promise<number> {
    const current = path.basename(this.file) === 'usage-v3.json';
    if (current) {
      await tightenOwnedPath(archiveDir(this.file), 0o700);
      await tightenOwnedPath(currentArchiveFile(this.file), 0o600);
    }
    const archived = await loadArchive(this.file, !current || !(await fileStamp(this.file)));
    if (!archived) return 0;
    let changed = false;
    const baseline = archived.records ? archived.legacy : { days: archived.days, before: Date.parse(archived.updatedAt) || Date.now() };
    const legacy = mergeLegacy(this.data.legacy, baseline);
    if (JSON.stringify(legacy) !== JSON.stringify(this.data.legacy)) { this.data.legacy = legacy; changed = true; }
    const hidden = [...new Set([...(this.data.hiddenSessions ?? []), ...(archived.hiddenSessions ?? [])])];
    if (hidden.length !== (this.data.hiddenSessions?.length ?? 0)) { this.data.hiddenSessions = hidden; changed = true; }
    let covers = archived.version === 3 && !!archived.records && JSON.stringify(archived.legacy) === JSON.stringify(this.data.legacy)
      && (archived.hiddenSessions?.length ?? 0) === (this.data.hiddenSessions?.length ?? 0);
    const archivedRecords = Object.values(archived.records ?? {});
    for (const rec of archivedRecords) {
      const prior = this.data.records[rec.id];
      if (!prior) { this.data.records[rec.id] = rec; changed = true; continue; }
      const next = JSON.stringify(prior) === JSON.stringify(rec) ? prior : preferredRecord(prior, rec);
      if (next !== prior) {
        if (!sameAccounting(next, prior)) changed = true;
        this.data.records[rec.id] = next;
      }
      if (covers && !sameAccounting(next, rec)) covers = false;
    }
    if (changed) {
      this.reaggregate();
      this.dirty = true;
      return Object.keys(this.data.days).length;
    }
    if (covers && Object.keys(this.data.records).length === archivedRecords.length) {
      this.archived = { records: this.data.records, legacy: this.data.legacy, hidden: this.data.hiddenSessions };
    }
    return 0;
  }

  private archiveMatches(): boolean {
    const archived = this.archived;
    return !!archived && archived.records === this.data.records && archived.legacy === this.data.legacy && archived.hidden === this.data.hiddenSessions;
  }

  async archive(): Promise<void> {
    if (!this.assertHeld) throw new Error('An archive write requires a store transaction');
    await this.assertHeld();
    if (this.archiveMatches()) return;
    await saveArchive(this.file, this.data, this.assertHeld);
    this.archived = { records: this.data.records, legacy: this.data.legacy, hidden: this.data.hiddenSessions };
  }

  rebuild(): void {
    this.data.files = {};
    this.reaggregate();
    this.dirty = true;
  }

  /**
   * Forgets the cursor of a log that is gone and lies outside every folder in `roots`. The collectors manage cursors inside
   * their own folders; a cursor left behind by a changed setting or a removed project would otherwise stay in the store for good.
   */
  async pruneFiles(roots: readonly string[]): Promise<number> {
    const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const inside = roots.map(root => fold(path.resolve(root)) + path.sep);
    let removed = 0;
    for (const key of Object.keys(this.data.files)) {
      if (inside.some(prefix => fold(path.resolve(key)).startsWith(prefix))) continue;
      const gone = await fs.stat(key).then(() => false, (err: NodeJS.ErrnoException) => err.code === 'ENOENT' || err.code === 'ENOTDIR');
      if (gone) { delete this.data.files[key]; removed++; }
    }
    if (removed) this.dirty = true;
    return removed;
  }

  /** `beforeCommit` runs once the temp file is on disk and may veto the rename by throwing. */
  async save(beforeCommit?: Fence): Promise<void> {
    if (!this.dirty) return;
    if (!isDays(this.data.days) || !isSessionTotals(this.data.sessions ?? {})) throw new Error('Invalid accounting totals; refusing to save');
    await publishPrivateFile(this.file, JSON.stringify({ ...this.data, ...splitBaseline(this.data.legacy) }), beforeCommit ?? this.assertHeld);
    this.dirty = false;
    this.savedAttempt = this.data.health?.attemptedAt;
  }
}
