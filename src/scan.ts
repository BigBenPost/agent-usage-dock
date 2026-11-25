import { AntigravityMeta, scanAntigravity } from './collectors/antigravity';
import { parseClaudeLine } from './collectors/claudeCode';
import { parseCodexLine } from './collectors/codex';
import { scanDsh } from './collectors/dsh';
import { FileState, LineScanOptions, scanDir } from './collectors/lines';
import { claudeHome, claudeProjects, codexHome, codexLogRoots, dataPaths, dshHome } from './paths';
import { rebuildBackup } from './backup';
import { isUsageRecord } from './reconcile';
import { UsageStore } from './store';
import { promises as fs } from 'fs';
import { SCANNED_SOURCES, ScannedSource, SOURCE_LABELS, Source, UsageRecord } from './types';

interface Collection {
  records: UsageRecord[];
  problems: string[];
  changedFiles: number;
  metadata?: { sessions: Map<string, AntigravityMeta>; updatedAt: number };
}

async function collectAntigravity(files: Record<string, FileState>, brain: string, db: string, conversations?: string, options?: LineScanOptions & { identityFiles?: Record<string, FileState> }): Promise<Collection> {
  const records: UsageRecord[] = [], problems: string[] = [];
  let metadata: Collection['metadata'];
  let changedFiles = 0;
  try { changedFiles = await scanAntigravity(brain, db, files, rec => records.push(rec), problems, conversations,
    { ...options, onMetadata: (sessions, updatedAt) => { metadata = { sessions, updatedAt }; } }); }
  catch (err) { if (options?.signal?.aborted) throw err; problems.push(err instanceof Error ? err.message : String(err)); }
  return { records, problems, changedFiles, metadata };
}

async function collectJsonl(source: Source, roots: string[], files: Record<string, FileState>, parse: (line: string, state: FileState) => UsageRecord | undefined, options: LineScanOptions) {
  const records: UsageRecord[] = [], problems: string[] = [];
  let changedFiles = 0;
  for (const root of roots) {
    changedFiles += await scanDir(root, files, (line, state) => {
      const record = parse(line, state);
      if (!record) return;
      if (!isUsageRecord(record, record.id)) throw new Error('Invalid usage record');
      records.push(record);
    }, problems, { ...options, label: SOURCE_LABELS[source] });
  }
  return { records, problems, changedFiles };
}

interface RefreshOptions extends LineScanOptions {
  source?: ScannedSource | 'all';
  antigravityEnabled?: boolean;
  dshHome?: string;
  dshEnabled?: boolean;
  claudeHome?: string;
  claudeEnabled?: boolean;
  codexHome?: string;
  codexEnabled?: boolean;
}

interface SourceCollection extends Collection {
  source: Source;
  root: string;
  status: 'disabled' | 'not-found' | 'incomplete' | 'ok';
}

interface LocalSource {
  root: string;
  required: boolean;
  enabled?: boolean;
  read: () => Promise<Collection>;
}

async function collectSource(source: Source, { root, required, enabled, read }: LocalSource, signal?: AbortSignal): Promise<SourceCollection> {
  signal?.throwIfAborted();
  const empty: Collection = { records: [], problems: [], changedFiles: 0 };
  if (enabled === false) return { ...empty, source, root, status: 'disabled' };
  try {
    if (!(await fs.stat(root)).isDirectory()) throw new Error('not a directory');
    const result = await read();
    return { ...result, source, root, status: result.problems.length ? 'incomplete' : 'ok' };
  } catch (err) {
    if (signal?.aborted) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !required) return { ...empty, source, root, status: 'not-found' };
    const reason = code ?? (err instanceof Error ? err.message : String(err));
    empty.problems.push(`${SOURCE_LABELS[source]} data directory unavailable: ${root} (${reason})`);
    return { ...empty, source, root, status: 'incomplete' };
  }
}

const MAX_REPORTED_REJECTIONS = 10;

/** Records the store refused (`store.rejected`) become problems of the source they came from. */
function reportRejected(store: UsageStore, results: SourceCollection[]): void {
  const { rejected } = store;
  let last: SourceCollection | undefined;
  for (const { id, reason } of rejected.slice(0, MAX_REPORTED_REJECTIONS)) {
    const owner = results.find(r => id.startsWith(r.source + ':')) ?? results[0];
    owner.problems.push(`Rejected usage record ${id}: ${reason}`);
    owner.status = 'incomplete';
    last = owner;
  }
  if (last && rejected.length > MAX_REPORTED_REJECTIONS) last.problems.push(`and ${rejected.length - MAX_REPORTED_REJECTIONS} more rejected usage records`);
}

const HEALTH_HEARTBEAT_MS = 15 * 60_000;
const healthFacts = (health: UsageStore['data']['sourceHealth']) => JSON.stringify(Object.fromEntries(Object.entries(health ?? {})
  .map(([source, value]) => [source, { root: value.root, status: value.status, problems: value.problems }])));

/** Collect without the write lock; merge facts under the lock against freshly loaded history. */
export async function refreshUsage(store: UsageStore, file: string, configured?: string, rebuild = false, options: RefreshOptions = {}) {
  const paths = dataPaths(configured);
  const before = structuredClone(store.data.files);
  const files = rebuild ? {} : structuredClone(before);
  const selected = options.source ?? 'antigravity';
  const dsh = dshHome(options.dshHome);
  const claude = claudeHome(options.claudeHome);
  const codex = codexHome(options.codexHome);
  const local: Record<ScannedSource, LocalSource> = {
    antigravity: { root: paths.home, required: selected === 'antigravity' || !!(configured || process.env.ANTIGRAVITY_HOME), enabled: options.antigravityEnabled, read: () => collectAntigravity(files, paths.brain, paths.db, paths.conversations, { ...options, identityFiles: before }) },
    dsh: { root: dsh, required: selected === 'dsh' || !!(options.dshHome || process.env.DSH_HOME), enabled: options.dshEnabled, read: () => scanDsh(dsh, files, options.signal) },
    claude: { root: claude, required: selected === 'claude' || !!(options.claudeHome || process.env.CLAUDE_CONFIG_DIR), enabled: options.claudeEnabled, read: () => collectJsonl('claude', [claudeProjects(claude)], files, parseClaudeLine, options) },
    codex: { root: codex, required: selected === 'codex' || !!(options.codexHome || process.env.CODEX_HOME), enabled: options.codexEnabled, read: () => collectJsonl('codex', codexLogRoots(codex), files, parseCodexLine, options) },
  };
  const results: SourceCollection[] = [];
  for (const source of SCANNED_SOURCES) {
    if (selected === 'all' || source === selected) results.push(await collectSource(source, local[source], options.signal));
  }
  const result = {
    records: results.flatMap(r => r.records),
    changedFiles: results.reduce((n, r) => n + r.changedFiles, 0),
  };
  options.signal?.throwIfAborted();
  return store.transaction(async checkpoint => {
    const backup = rebuild ? await rebuildBackup(file) : undefined;
    if (rebuild) store.rebuild();
    // Apply metadata to freshly merged history, including unchanged or deleted logs and
    // records another writer added while this scan ran. Counter provenance stays intact.
    const metadata = results.find(r => r.source === 'antigravity')?.metadata;
    if (metadata) {
      // One carrier per session is enough: aggregate() applies its metadata to the
      // whole session. Do not rewrite every historical request on each title change.
      const carriers = new Map<string, UsageRecord>();
      for (const rec of [...Object.values(store.data.records), ...result.records]) {
        if (rec.source !== 'antigravity' || !rec.session || !metadata.sessions.has(rec.session)) continue;
        const prior = carriers.get(rec.session);
        if (!prior || (rec.evidence?.antigravityMetadataAt ?? -1) > (prior.evidence?.antigravityMetadataAt ?? -1)) carriers.set(rec.session, rec);
      }
      for (const [session, rec] of carriers) {
        if ((rec.evidence?.antigravityMetadataAt ?? -1) >= metadata.updatedAt) continue;
        const meta = metadata.sessions.get(session)!;
        result.records.push({ ...rec, title: meta.title, project: meta.project,
          evidence: { kind: 'transcript', revision: 0, parserVersion: 3, ...rec.evidence, antigravityMetadataAt: metadata.updatedAt } });
      }
    }
    const changed = store.addRecords(result.records);
    reportRejected(store, results);
    const codexResult = results.find(r => r.source === 'codex' && (r.status === 'ok' || r.status === 'incomplete'));
    if (codexResult && store.data.codexProblems?.length) {
      codexResult.problems.push(...store.data.codexProblems);
      codexResult.status = 'incomplete';
    }
    // A concurrent reader may have progressed further. Only advance the cursor we actually collected from.
    for (const key of new Set([...Object.keys(before), ...Object.keys(files)])) {
      if (rebuild || JSON.stringify(store.data.files[key]) === JSON.stringify(before[key])) {
        if (files[key]) store.data.files[key] = files[key]; else delete store.data.files[key];
      }
    }
    const previousHealth = healthFacts(store.data.sourceHealth);
    const lastAttempt = Date.parse(store.checkpointedAttempt ?? '');
    const heartbeatDue = !Number.isFinite(lastAttempt) || Date.now() - lastAttempt >= HEALTH_HEARTBEAT_MS;
    const stamp = new Date().toISOString();
    store.data.sourceHealth ??= {};
    for (const { source, root, status, problems } of results) {
      const previous = store.data.sourceHealth[source];
      store.data.sourceHealth[source] = { root, status, attemptedAt: stamp, succeededAt: status === 'ok' ? stamp : previous?.root === root ? previous.succeededAt : undefined, problems };
    }
    const allProblems = Object.values(store.data.sourceHealth).flatMap(h => h.problems);
    const persistentChange = heartbeatDue || previousHealth !== healthFacts(store.data.sourceHealth) || changed > 0 || rebuild || JSON.stringify(store.data.files) !== JSON.stringify(before) || !store.data.health || store.data.health.root !== paths.home || JSON.stringify(store.data.health.problems) !== JSON.stringify(allProblems);
    const now = new Date().toISOString();
    store.data.health = { root: paths.home, attemptedAt: now, succeededAt: allProblems.length ? store.data.health?.succeededAt : now, problems: allProblems };
    if (persistentChange) store.markDirty();
    await checkpoint();
    await store.archive();
    return { changed, files: result.changedFiles, problems: results.flatMap(r => r.problems), sources: results.map(({ source, status }) => ({ source, status })), backup };
  }, true);
}
