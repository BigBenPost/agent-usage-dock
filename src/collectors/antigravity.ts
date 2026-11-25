import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_BRAIN_ROOT, ANTIGRAVITY_CONVERSATIONS_ROOT, ANTIGRAVITY_DB_PATH } from '../paths';
import { isUsageRecord } from '../reconcile';
import { SOURCE_LABELS, UsageRecord } from '../types';
import { dayOfMs, describe, entryKind, FileState, isGone, LineScanOptions, MAX_SKIPPED_SAMPLES, num, readNewLines, realFirst, safeModel, skippedProblem, skippedSamples, timestampMs, utcDay } from './lines';
import { SqliteSession } from './sqlite';
import { isCount } from '../validation';

export interface AntigravityMeta {
  title?: string;
  project?: string;
  lastModifiedMs: number;
}

const PARSER_VERSION = 3;
const FULL_PASS_MS = 10 * 60_000;
const FULL_PASS_JITTER = 0.2;

/**
 * How long a conversation database goes between full passes. Each file gets a fixed extra 0 to 20 percent, derived from its
 * path, so databases that were first read together do not all expire in the same poll.
 */
export function fullPassInterval(file: string): number {
  const fraction = createHash('sha1').update(file).digest().readUInt32BE(0) / 2 ** 32;
  return FULL_PASS_MS * (1 + FULL_PASS_JITTER * fraction);
}

const metadataCache = new Map<string, { key: string; map: Map<string, AntigravityMeta> }>();
const nonEmpty = (value: unknown): string | undefined => {
  const text = String(value ?? '');
  return text.trim() ? text : undefined;
};

/**
 * Loads conversation metadata (title, project directory, last modified time) from Google Antigravity's
 * conversation_summaries.db, with node:sqlite when the runtime has it and the sqlite3 CLI otherwise. The result is kept in
 * memory per file revision, so an unchanged database is not queried again. Treat the returned map as read-only.
 */
export async function loadConversationMetadata(dbPath = ANTIGRAVITY_DB_PATH, session?: SqliteSession): Promise<Map<string, AntigravityMeta>> {
  try {
    const revision = await databaseRevision(dbPath).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
    if (!revision) return new Map();
    const cached = metadataCache.get(dbPath);
    if (cached?.key === revision.key) return cached.map;
    const sql = 'SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries';
    let rows;
    if (session) rows = await session.rows(dbPath, sql);
    else {
      const own = new SqliteSession();
      try { rows = await own.rows(dbPath, sql); } finally { await own.close(); }
    }
    const map = new Map<string, AntigravityMeta>();
    for (const row of rows) {
      const id = String(row.conversation_id), uris = String(row.workspace_uris ?? '[]'), lastMod = String(row.last_modified_time ?? '');
      let project: string | undefined;
      try {
        const parsed = JSON.parse(uris);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const rawUri = String(parsed[0]);
          project = nonEmpty(path.basename(rawUri.replace(/^file:\/\//, '')));
        }
      } catch {
        // invalid JSON in workspace_uris
      }
      map.set(id, { title: nonEmpty(row.title), project, lastModifiedMs: Date.parse(lastMod) || 0 });
    }
    metadataCache.set(dbPath, { key: revision.key, map });
    return map;
  } catch {
    throw new Error('Cannot read conversation metadata: ' + dbPath);
  }
}

/**
 * Normalizes an Antigravity model name to a clean identifier matching pricing patterns.
 */
export function normalizeAntigravityModel(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (lower === 'unknown-model') return 'unknown-model';
  const clean = lower.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, '-');
  const model = /^(sonnet|opus|haiku)-/.test(clean) ? 'claude-' + clean : clean;
  return safeModel(model);

}

/**
 * Maps Antigravity's protobuf model enum to model name.
 */
export function modelFromEnum(id: number): string {
  switch (id) {
    case 1035:
      return 'claude-sonnet-4.6';
    case 1026:
      return 'claude-opus-4.6';
    case 1318:
    case 1319:
      return 'gemini-3.8-flash';
    case 1525:
      return 'gemini-4-hydrogen';
    default:
      return 'unknown-model';
  }
}

/**
 * Decodes protobuf wire fields from a byte buffer.
 */
export function decodeProtoFields(buf: Uint8Array): { fieldNum: number; val: unknown }[] {
  let pos = 0;
  const fields: { fieldNum: number; val: unknown }[] = [];
  const varint = (): number => {
    let n = 0, scale = 1;
    for (let i = 0; i < 8; i++) {
      if (pos >= buf.length) throw new Error('Truncated protobuf varint');
      const byte = buf[pos++]; n += (byte & 127) * scale;
      if (!Number.isSafeInteger(n)) throw new Error('Protobuf integer exceeds safe range');
      if (!(byte & 128)) return n;
      scale *= 128;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (pos < buf.length) {
    const key = varint(), fieldNum = Math.floor(key / 8), wire = key % 8;
    if (fieldNum < 1) throw new Error('Invalid protobuf field');
    if (wire === 0) fields.push({ fieldNum, val: varint() });
    else if (wire === 2) {
      const length = varint();
      if (length > buf.length - pos) throw new Error('Truncated protobuf field');
      fields.push({ fieldNum, val: buf.subarray(pos, pos + length) }); pos += length;
    } else if (wire === 1 || wire === 5) {
      pos += wire === 1 ? 8 : 4;
      if (pos > buf.length) throw new Error('Truncated protobuf fixed field');
    } else throw new Error('Unsupported protobuf wire type');
  }
  return fields;

}

/**
 * Parses one JSON line from transcript.jsonl.
 * Returns a UsageRecord if the step contains token counts.
 */
export function parseAntigravityLine(
  line: string,
  conversationId: string,
  meta?: AntigravityMeta,
  detectedModel?: string,
): UsageRecord | undefined {
  if (!line.includes('"input_tokens"') && !line.includes('"output_tokens"') && !line.includes('"cache_read_tokens"')) {
    return undefined;
  }
  let entry: any;
  try {
    entry = JSON.parse(line);
  } catch {
    throw new Error('Malformed Antigravity usage line');
  }
  if (!entry || typeof entry !== 'object') return undefined;
  const counts = [entry.input_tokens, entry.output_tokens, entry.cache_read_tokens].filter(value => value != null);
  if (!counts.length) return undefined;
  if (!counts.every(isCount)) throw new Error('Invalid Antigravity token count');
  const inTok = num(entry.input_tokens);
  const outTok = num(entry.output_tokens);
  const cacheReadTok = num(entry.cache_read_tokens);
  const day = utcDay(entry.created_at);
  if (!day || !isCount(entry.step_index)) throw new Error('Missing Antigravity usage timestamp or step index');
  const stepIndex = String(entry.step_index);
  const id = `antigravity:${conversationId}:${stepIndex}`;
  const model = normalizeAntigravityModel(typeof entry.model === 'string' ? entry.model : detectedModel ?? 'unknown-model');

  return {
    id,
    evidence: { kind: 'transcript', revision: 0, parserVersion: PARSER_VERSION, rawModel: typeof entry.model === 'string' ? entry.model : detectedModel },
    source: 'antigravity',
    day,
    model,
    tokens: {
      input: inTok,
      cacheRead: cacheReadTok,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: outTok,
    },
    session: conversationId,
    title: meta?.title,
    project: meta?.project,
    ts: timestampMs(entry.created_at),
  };
}

/**
 * Parses protobuf metadata from a conversation DB step record.
 */
export function parseDbStepMetadata(
  metaBuf: Uint8Array,
  cid: string,
  idx: number,
  meta?: AntigravityMeta,
): UsageRecord | undefined {
  const top = decodeProtoFields(metaBuf);
  const f1 = top.find((f) => f.fieldNum === 1);
  const f9 = top.find((f) => f.fieldNum === 9);
  if (!f9 || !(f9.val instanceof Uint8Array)) return undefined;

  const f9Fields = decodeProtoFields(f9.val);
  const counts = [2, 3, 5].map(field => f9Fields.find(f => f.fieldNum === field)?.val);
  if (counts.every(value => value === undefined)) return undefined;
  if (counts.some(value => value !== undefined && !isCount(value))) throw new Error('Invalid Antigravity database token count');
  const [inTok, outTok, cacheTok] = counts.map(num);

  const tsSec = f1?.val instanceof Uint8Array ? decodeProtoFields(f1.val).find((f) => f.fieldNum === 1)?.val : undefined;
  if (!tsSec || typeof tsSec !== 'number') {
    if ([inTok, outTok, cacheTok].every(count => count === 0)) return undefined;
    throw new Error('Antigravity database step has token counts but no time');
  }

  const modelEnum = Number(f9Fields.find((f) => f.fieldNum === 1)?.val || 0);
  let model = modelFromEnum(modelEnum);

  const tsMs = tsSec * 1000;
  const day = dayOfMs(tsMs);
  if (!day) throw new Error('Antigravity database step has an out-of-range timestamp');

  return {
    id: `antigravity:${cid}:${idx}`,
    evidence: { kind: 'database', revision: 0, parserVersion: PARSER_VERSION, rawModel: `enum:${modelEnum}` },
    source: 'antigravity',
    day,
    model,
    tokens: {
      input: inTok,
      cacheRead: cacheTok,
      cacheWrite: 0,
      cacheWrite1h: 0,
      output: outTok,
    },
    session: cid,
    title: meta?.title,
    project: meta?.project,
    ts: tsMs,
  };
}

/**
 * Lists all transcript.jsonl files under the Antigravity brain directory. A conversation folder may be a symlink; one that
 * points nowhere counts as gone, and any other failure is added to `problems`.
 */
export async function listAntigravityTranscripts(brainRoot = ANTIGRAVITY_BRAIN_ROOT, problems: string[] = []): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(brainRoot, { withFileTypes: true });
  } catch (err) {
    if (!isGone(err)) problems.push(`cannot list ${brainRoot}: ${describe(err)}`);
    return out;
  }
  const listed = new Set<string>();
  const brain = await fs.realpath(brainRoot).catch(() => brainRoot);
  for (const entry of realFirst(entries)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const transcriptPath = path.join(brainRoot, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      if (!(await fs.stat(transcriptPath)).isFile()) continue;
      const real = entry.isSymbolicLink() ? await fs.realpath(transcriptPath) : path.join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      if (listed.has(real)) continue;
      listed.add(real);
      out.push(transcriptPath);
    } catch (err) {
      // ENOTDIR: the entry is a link to a plain file, not a conversation folder.
      if (!isGone(err) && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') problems.push(`cannot read ${transcriptPath}: ${describe(err)}`);
    }
  }
  return out;
}

/**
 * Lists all SQLite conversation database files under the conversations directory, following symlinked files.
 */
export async function listAntigravityConversationDbs(conversationsRoot = ANTIGRAVITY_CONVERSATIONS_ROOT, problems: string[] = []): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(conversationsRoot, { withFileTypes: true });
  } catch (err) {
    if (!isGone(err)) problems.push(`cannot list ${conversationsRoot}: ${describe(err)}`);
    return out;
  }
  const listed = new Set<string>();
  const root = await fs.realpath(conversationsRoot).catch(() => conversationsRoot);
  for (const e of realFirst(entries)) {
    if (!e.name.endsWith('.db') || e.name.includes('-wal') || e.name.includes('-shm')) continue;
    if (await entryKind(conversationsRoot, e, problems) !== 'file') continue;
    const real = e.isSymbolicLink() ? await fs.realpath(path.join(conversationsRoot, e.name)).catch(() => undefined) : path.join(root, e.name);
    if (!real || listed.has(real)) continue;
    listed.add(real);
    out.push(path.join(conversationsRoot, e.name));
  }
  return out;
}

export interface ConversationDbRead {
  records: UsageRecord[];
  /** Steps that could not be decoded; `offset` is the step index. */
  skipped: { offset: number; reason: string }[];
  /** Highest step index that produced a record or was skipped, or `after` when there was none. */
  last: number;
}

/**
 * Reads usage records from a conversation SQLite database. Outside strict mode a step that cannot be decoded is skipped and
 * listed in the result; in strict mode it fails the read.
 */
export async function readConversationDbRecords(
  dbPath: string,
  metaMap: Map<string, AntigravityMeta>,
  after = -1,
  options: { session?: SqliteSession; strict?: boolean } = {},
): Promise<ConversationDbRead> {
  const records: UsageRecord[] = [];
  const skipped: ConversationDbRead['skipped'] = [];
  const cid = path.basename(dbPath).replace(/\.db$/, '');
  const meta = metaMap.get(cid);
  const own = options.session ? undefined : new SqliteSession();
  const session = options.session ?? own!;
  try {
    const revision = await databaseRevision(dbPath);
    let cursor = after;
    let last = after;
    for (;;) {
      const rows = await session.rows(dbPath, 'SELECT idx, hex(metadata) AS metadata FROM steps WHERE step_type = 15 AND idx > ' + cursor + ' ORDER BY idx LIMIT 256');
      for (const r of rows) {
        const idx = Number(r.idx);
        if (!Number.isSafeInteger(idx) || idx <= cursor) throw new Error('Invalid database step index');
        cursor = idx;
        try {
          const rec = parseDbStepMetadata(Buffer.from(String(r.metadata), 'hex'), cid, idx, meta);
          if (rec) {
            rec.evidence = { ...rec.evidence!, revision: revision.time };
            if (!isUsageRecord(rec, rec.id)) throw new Error('Invalid usage record');
            records.push(rec);
            last = idx;
          }
        } catch (err) {
          if (options.strict) throw err;
          skipped.push({ offset: idx, reason: (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 160) || 'unreadable' });
          last = idx;
        }
      }
      if (rows.length < 256) break;
    }
    return { records, skipped, last };
  } finally {
    await own?.close();
  }
}

/**
 * Incrementally scans Antigravity transcripts and conversation DBs into file states, emitting records. Lines and steps that
 * cannot be read are skipped, recorded in the file's state and added to `problems` on every scan while the state carries them.
 */
export async function scanAntigravity(
  brainRoot: string,
  dbPath: string,
  files: Record<string, FileState>,
  emit: (rec: UsageRecord) => void,
  problems: string[] = [],
  conversationsRoot?: string,
  options: LineScanOptions = {},
): Promise<number> {
  const resolvedConvRoot = conversationsRoot ?? path.join(path.dirname(brainRoot), 'conversations');
  const label = SOURCE_LABELS.antigravity;
  const listing = problems.length;
  const transcripts = await listAntigravityTranscripts(brainRoot, problems);
  const conversationDbs = await listAntigravityConversationDbs(resolvedConvRoot, problems);
  const session = new SqliteSession('auto', options.signal);
  try {
    const metaMap = await loadConversationMetadata(dbPath, session).catch(err => { problems.push(String(err)); return new Map<string, AntigravityMeta>(); });
    let changed = 0;
    const live = new Set([...transcripts, ...conversationDbs]);
    // A folder that failed to list looks empty; its files are not gone, so their states stay.
    if (problems.length === listing) {
      for (const key of Object.keys(files)) if ((key.startsWith(brainRoot + path.sep) || key.startsWith(resolvedConvRoot + path.sep)) && !live.has(key)) { delete files[key]; changed++; }
    }

    // 1. Scan live/active transcript.jsonl files
    for (const file of transcripts) {
      options.signal?.throwIfAborted();
      const parts = file.split(path.sep);
      const cidIdx = parts.lastIndexOf('.system_generated') - 1;
      const cid = cidIdx >= 0 ? parts[cidIdx] : path.basename(path.dirname(path.dirname(path.dirname(file))));
      const meta = metaMap.get(cid);

      try {
        const state = await readNewLines(file, files[file], (line, s) => {
          if (line.includes('<USER_SETTINGS_CHANGE>') && line.includes('Model Selection')) {
            const match = /Model Selection\` from (?:None|.*?) to (.*?)\.\s+No need/i.exec(line)
              || /Model Selection\` from (?:None|.*?) to (.*?)\./i.exec(line);
            if (match) s.model = match[1].trim();
          }
          const rec = parseAntigravityLine(line, cid, meta, s.model);
          if (!rec) return;
          if (rec.model !== 'unknown-model') s.model = rec.model;
          rec.evidence = { ...rec.evidence!, revision: Math.max(s.mtimeMs, s.ctimeMs ?? 0) };
          if (!isUsageRecord(rec, rec.id)) throw new Error('Invalid usage record');
          emit(rec);
        }, options);
        if (state !== files[file]) {
          files[file] = state;
          changed++;
        }
      } catch (err) {
        if (options.signal?.aborted) throw err;
        problems.push(`cannot read Antigravity transcript ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const skipped = skippedProblem(label, file, files[file]?.skipped);
      if (skipped) problems.push(skipped);
    }

    // 2. Scan historical and current conversation database files
    for (const dbFile of conversationDbs) {
      options.signal?.throwIfAborted();
      try {
        const st = await fs.stat(dbFile);
        const revision = await databaseRevision(dbFile);
        const state = files[dbFile];
        const interval = fullPassInterval(dbFile);
        if (state && state.fingerprint === revision.key && (!options.strict || state.strictRead) && Date.now() - (state.lastFullScan ?? 0) < interval) {
          const skipped = skippedProblem(label, dbFile, state.skipped, 'step');
          if (skipped) problems.push(skipped);
          continue; // Unchanged database file
        }

        const full = options.strict || !state?.fingerprint?.endsWith(`:${PARSER_VERSION}`) || !state.lastFullScan || Date.now() - state.lastFullScan > interval;
        const windowStart = full ? -1 : Math.max(-1, (state.dbCursor ?? 0) - 256);
        const { records, skipped, last } = await readConversationDbRecords(dbFile, metaMap, windowStart, { session, strict: options.strict });
        if (options.strict && (await databaseRevision(dbFile)).key !== revision.key) throw new Error('Conversation database changed during flush');
        for (const rec of records) emit(rec);
        const earlier = full ? [] : skippedSamples(state.skipped);
        const kept = earlier.filter(sample => sample.offset <= windowStart);
        const count = (full ? 0 : Math.max(0, (Number.isSafeInteger(state.skipped?.count) ? state.skipped!.count : 0) - (earlier.length - kept.length))) + skipped.length;
        const next: FileState = { size: st.size, mtimeMs: revision.time, offset: st.size, fingerprint: revision.key, strictRead: options.strict, dbCursor: Math.max(state?.dbCursor ?? -1, last), lastFullScan: full ? Date.now() : state.lastFullScan };
        if (count) next.skipped = { count, samples: [...kept, ...skipped].slice(0, MAX_SKIPPED_SAMPLES) };
        files[dbFile] = next;
        changed++;
        const reported = skippedProblem(label, dbFile, next.skipped, 'step');
        if (reported) problems.push(reported);
      } catch (err) {
        if (options.signal?.aborted) throw err;
        problems.push(`cannot read Antigravity conversation DB ${dbFile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return changed;
  } finally {
    await session.close();
  }
}

async function databaseRevision(file: string): Promise<{ key: string; time: number }> {
  const db = await fs.stat(file);
  const home = await fs.realpath(file).catch(() => file);
  const wal = await fs.stat(home + '-wal').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e; });
  return { key: [db.ino, db.size, db.mtimeMs, db.ctimeMs, wal?.ino, wal?.size, wal?.mtimeMs, wal?.ctimeMs, PARSER_VERSION].join(':'), time: Math.max(db.mtimeMs, db.ctimeMs, wal?.mtimeMs ?? 0, wal?.ctimeMs ?? 0) };
}
