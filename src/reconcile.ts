import { accountingKey } from './projection';
import { DayRecord, emptyBucket, SessionRecord, SOURCES, Source, TOKEN_KEYS, TokenBucket, UsageRecord } from './types';
import { compareCodeUnits, isCount, isDay, isLegacy, isObject, isTime, safeKey } from './validation';
import { isSafeSessionId } from './sessionId';
import { codexAliases } from './collectors/codex';

/** One deterministic ordering for incremental scans, imports and archive recovery. */
export function preferredRecord(a: UsageRecord, b: UsageRecord): UsageRecord {
  const winner = preferredFacts(a, b);
  if (a.source !== 'antigravity' || b.source !== 'antigravity') return winner;
  const meta = preferredMetadata(a, b);
  if (!meta) return winner;
  return { ...winner, title: meta.title, project: meta.project,
    evidence: { ...(winner.evidence ?? meta.evidence!), antigravityMetadataAt: meta.evidence!.antigravityMetadataAt } };
}

function preferredMetadata(a: UsageRecord, b: UsageRecord): UsageRecord | undefined {
  const at = a.evidence?.antigravityMetadataAt ?? -1;
  const bt = b.evidence?.antigravityMetadataAt ?? -1;
  if (at < 0 && bt < 0) return undefined;
  // Metadata may be newer even when its request counters lose reconciliation.
  // A missing row has no evidence; a present row with empty fields explicitly clears them.
  return at !== bt ? (at > bt ? a : b)
    : JSON.stringify([a.title ?? null, a.project ?? null]) >= JSON.stringify([b.title ?? null, b.project ?? null]) ? a : b;
}

function preferredFacts(a: UsageRecord, b: UsageRecord): UsageRecord {
  const rank = (r: UsageRecord) => [r.evidence?.kind === 'database' ? 2 : r.evidence?.kind === 'transcript' ? 1 : 0,
    r.evidence?.revision ?? 0, r.evidence?.parserVersion ?? 0, r.tokens.output, r.tokens.input, r.tokens.cacheRead, r.tokens.cacheWrite, r.tokens.cacheWrite1h,
    r.model === 'unknown-model' ? 0 : 1];
  const ar = rank(a), br = rank(b);
  const difference = ar.findIndex((value, index) => value !== br[index]);
  const winner = difference >= 0 ? (ar[difference] > br[difference] ? a : b) : (JSON.stringify(a) >= JSON.stringify(b) ? a : b);
  const other = winner === a ? b : a;
  if (winner.source === 'antigravity' && other.source === 'antigravity' && other.model !== 'unknown-model') {
    const known = winner.evidence?.antigravityModel ?? winner.evidence;
    const incoming = other.evidence?.antigravityModel ?? other.evidence;
    const scores = (e: typeof known) => [e?.kind === 'database' ? 2 : e?.kind === 'transcript' ? 1 : 0, e?.revision ?? 0, e?.parserVersion ?? 0];
    const wr = scores(known), or = scores(incoming);
    const next = wr.findIndex((value, index) => value !== or[index]);
    if (winner.model === 'unknown-model' || (next >= 0 ? or[next] > wr[next] : other.model > winner.model)) {
      const antigravityModel = incoming && { kind: incoming.kind, revision: incoming.revision, parserVersion: incoming.parserVersion };
      return { ...winner, model: other.model, evidence: winner.evidence && { ...winner.evidence, antigravityModel } };
    }
  }
  if (winner.source === 'cursor' && other.source === 'cursor' && !winner.session && other.session) return { ...winner, session: other.session };
  if (winner.source === 'codex' && other.source === 'codex' && winner.evidence && !winner.evidence.codexAlias && other.evidence?.codexAlias) {
    return { ...winner, evidence: { ...winner.evidence, codexAlias: other.evidence.codexAlias } };
  }
  if (winner.source === 'claude' && other.source === 'claude') {
    const raised = TOKEN_KEYS.some(key => other.tokens[key] > winner.tokens[key]);
    const earlier = precedes(other, winner);
    if (!raised && !earlier) return winner;
    const tokens = { ...winner.tokens };
    for (const key of TOKEN_KEYS) tokens[key] = Math.max(winner.tokens[key], other.tokens[key]);
    return { ...winner, ...(earlier && { day: other.day, ts: other.ts, session: other.session, project: other.project }), tokens };
  }
  return winner;
}

/**
 * Whether `a` is the copy of one Claude message that attributes it (day, time, session and project): the earlier timestamp,
 * then the smaller session id and project by code unit, a missing one last. A total order, so the result does not depend on
 * which copy arrived first. The counts are the other half of a message: a streamed update can report only some of them, a
 * missing one reads as 0, and each count only grows, so the larger of the copies' counts is the message's.
 */
function precedes(a: UsageRecord, b: UsageRecord): boolean {
  const timestamp = (r: UsageRecord) => r.ts ?? Date.parse(r.day + 'T00:00:00Z');
  const optional = (x?: string, y?: string) => (x === y ? 0 : x === undefined ? 1 : y === undefined ? -1 : compareCodeUnits(x, y));
  return (timestamp(a) - timestamp(b) || optional(a.session, b.session) || optional(a.project, b.project)) < 0;
}

/** Equal accounting facts: identical except for the revision, which only says when the source was last read. */
export function sameAccounting(a: UsageRecord, b: UsageRecord): boolean {
  return a === b || JSON.stringify(ordered(a, 'revision')) === JSON.stringify(ordered(b, 'revision'));
}

/**
 * What an older store knew: the totals per day and, when it kept them, per session. A session's own `last` says how far its totals
 * reach, so the sessions need no cutoff of their own.
 */
export interface LegacyBaseline { days: Record<string, DayRecord>; before: number; sessions?: Record<string, SessionRecord> }

function ordered(value: unknown, omit?: string): unknown {
  return isObject(value) ? Object.fromEntries(Object.keys(value).sort().filter(key => key !== omit).map(key => [key, ordered(value[key], omit)])) : value;
}

const COUNTERS = ['requests', ...TOKEN_KEYS] as const;

function mergeLegacyDays(a: LegacyBaseline, b: LegacyBaseline): Pick<LegacyBaseline, 'days' | 'before'> {
  if (!Object.keys(a.days).length) return { days: structuredClone(b.days), before: b.before };
  if (!Object.keys(b.days).length) return { days: structuredClone(a.days), before: a.before };
  if (JSON.stringify(ordered(a.days)) === JSON.stringify(ordered(b.days))) return { days: structuredClone(a.days), before: Math.min(a.before, b.before) };
  const before = Math.max(a.before, b.before);
  const days = structuredClone(a.days);
  for (const baseline of [a, b]) for (const day of Object.keys(baseline.days)) {
    const end = Date.parse(day + 'T00:00:00Z') + 86400_000 - 1;
    if (Math.min(baseline.before, end) !== Math.min(before, end)) throw new Error('Legacy merge conflict: different coverage cutoff on ' + day);
  }
  for (const [day, sources] of Object.entries(b.days)) for (const [source, models] of Object.entries(sources)) {
    const target = ((days[day] ??= {})[source as Source] ??= {});
    for (const [model, bucket] of Object.entries(models ?? {})) {
      const prior = target[model];
      if (prior && COUNTERS.some(k => prior[k] !== bucket[k])) throw new Error('Legacy merge conflict: overlapping bucket on ' + day + '/' + source + '/' + model);
      target[model] = structuredClone(bucket);
    }
  }
  return { days, before };
}

/**
 * Two snapshots of one session are two readings of the same growing counters, so each counter takes the larger reading: merging is
 * repeatable, in either order, and a later snapshot of the same ledger replaces an earlier one.
 */
function mergeSessionTotal(a: SessionRecord, b: SessionRecord): SessionRecord {
  const newer = b.last >= a.last ? b : a;
  const older = newer === b ? a : b;
  const out: SessionRecord = { source: a.source, id: a.id, first: Math.min(a.first, b.first), last: Math.max(a.last, b.last), days: {} };
  const title = newer.title ?? older.title;
  const project = newer.project ?? older.project;
  if (title !== undefined) out.title = title;
  if (project !== undefined) out.project = project;
  for (const day of [...new Set([...Object.keys(a.days), ...Object.keys(b.days)])].sort(compareCodeUnits)) {
    const byModel: Record<string, TokenBucket> = {};
    for (const model of [...new Set([...Object.keys(a.days[day] ?? {}), ...Object.keys(b.days[day] ?? {})])].sort(compareCodeUnits)) {
      const x = a.days[day]?.[model], y = b.days[day]?.[model];
      const bucket = emptyBucket();
      for (const k of COUNTERS) bucket[k] = Math.max(x?.[k] ?? 0, y?.[k] ?? 0);
      byModel[model] = bucket;
    }
    out.days[day] = byModel;
  }
  return out;
}

function mergeLegacySessions(a?: Record<string, SessionRecord>, b?: Record<string, SessionRecord>): Record<string, SessionRecord> | undefined {
  if (!a || !b) return structuredClone(a ?? b);
  if (JSON.stringify(ordered(a)) === JSON.stringify(ordered(b))) return structuredClone(a);
  const out: Record<string, SessionRecord> = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(compareCodeUnits)) {
    out[key] = a[key] && b[key] ? mergeSessionTotal(a[key], b[key]) : structuredClone(a[key] ?? b[key]);
  }
  return out;
}

/**
 * Aggregates cannot establish overlap. Reject conflicting snapshots instead of dropping either one. The sessions are the exception:
 * they are merged, since a session counted twice shows as the larger of its two counts rather than their sum.
 */
export function mergeLegacy(a?: LegacyBaseline, b?: LegacyBaseline): LegacyBaseline | undefined {
  if ((a && !isLegacy(a)) || (b && !isLegacy(b))) throw new Error('Invalid legacy baseline');
  if (!a || !b) return structuredClone(a ?? b);
  const merged = mergeLegacyDays(a, b);
  const sessions = mergeLegacySessions(a.sessions, b.sessions);
  return sessions ? { ...merged, sessions } : merged;
}

/**
 * On disk the session totals of a baseline sit beside it, not in it. A build that does not know them rebuilds `legacy` on its first
 * transaction and would take them with it; kept apart they stay where they are, and such a build cannot read what it ignores.
 */
export function splitBaseline(legacy?: LegacyBaseline): { legacy?: Pick<LegacyBaseline, 'days' | 'before'>; legacySessions?: Record<string, SessionRecord> } {
  if (!legacy) return {};
  const { sessions, ...baseline } = legacy;
  return sessions && Object.keys(sessions).length ? { legacy: baseline, legacySessions: sessions } : { legacy: baseline };
}

/** The baseline as it is held in memory: the session totals that were kept apart, put back into it. A baseline already validated. */
export function joinBaseline(legacy: LegacyBaseline | undefined, apart: Record<string, SessionRecord> | undefined): LegacyBaseline | undefined {
  if (!apart) return legacy;
  return { days: legacy?.days ?? {}, before: legacy?.before ?? 0, sessions: mergeLegacySessions(legacy?.sessions, apart) };
}

/** Takes one request out of the totals an older store counted, the same model first: what the logs still hold is not counted twice. */
function consume(models: Record<string, TokenBucket>, rec: UsageRecord): void {
  const keys = Object.keys(models).sort((a, b) => Number(b === rec.model) - Number(a === rec.model) || compareCodeUnits(a, b));
  const pending = { requests: 1, ...rec.tokens };
  for (const key of keys) {
    const old = models[key];
    for (const k of COUNTERS) {
      const covered = Math.min(old[k], pending[k]); old[k] -= covered; pending[k] -= covered;
    }
  }
}

/** A new parser's verified call evidence suppresses old IDs reintroduced by archive/import. */
export function canonicalRecords(records: Record<string, UsageRecord>, codexProblems?: string[]): Record<string, UsageRecord> {
  const aliases = new Map<string, string>();
  for (const rec of Object.values(records)) {
    if (!isUsageRecord(rec, rec.id)) throw new Error('Invalid accounting record');
    const call = rec.evidence?.dshCall;
    if (!call) continue;
    for (const seq of call.sequences) {
      const id = 'dsh:' + rec.session + ':' + seq;
      const prior = aliases.get(id);
      if (prior && prior !== rec.id) throw new Error('Conflicting DSH call identity evidence');
      aliases.set(id, rec.id);
    }
  }
  const codex = codexAliases(records, codexProblems);
  const out: Record<string, UsageRecord> = {};
  for (const rec of Object.values(records)) {
    if (codex.aliases.has(rec.id) || (aliases.has(rec.id) && aliases.get(rec.id) !== rec.id)) continue;
    const codexAlias = codex.verified.get(rec.id);
    out[rec.id] = codexAlias && rec.evidence ? { ...rec, evidence: { ...rec.evidence, codexAlias } } : rec;
  }
  return out;
}

/** Check before addition; rounding an overflowing sum must never become a persisted accounting fact. */
function addAccounting(target: TokenBucket, value: TokenBucket): void {
  for (const key of COUNTERS) {
    if (value[key] > Number.MAX_SAFE_INTEGER - target[key]) throw new Error('Accounting total exceeds safe integer range');
  }
  for (const key of COUNTERS) target[key] += value[key];
}

export function aggregate(records: Record<string, UsageRecord>, legacy?: LegacyBaseline, hidden: Iterable<string> = [], canonical = false): {
  days: Record<string, DayRecord>; sessions: Record<string, SessionRecord>; firstDay?: string;
} {
  if (legacy && !isLegacy(legacy)) throw new Error('Invalid legacy baseline');
  const days: Record<string, DayRecord> = {};
  const sessions: Record<string, SessionRecord> = {};
  const hiddenSessions = new Set(hidden);
  const labelledAt = new Map<string, { title: number; project: number }>();
  const metadata = new Map<string, UsageRecord>();
  const remaining: Record<string, DayRecord> = JSON.parse(JSON.stringify(legacy?.days ?? {}));
  const remainingSessions: Record<string, SessionRecord> = structuredClone(legacy?.sessions ?? {});
  for (const rec of Object.values(canonical ? records : canonicalRecords(records)).sort((a, b) => compareCodeUnits(a.id, b.id))) {
    const key = accountingKey(rec);
    const bucket = (((days[rec.day] ??= {})[rec.source] ??= {})[key] ??= emptyBucket());
    addAccounting(bucket, { requests: 1, ...rec.tokens });
    const ts = rec.ts ?? Date.parse(`${rec.day}T00:00:00Z`);
    if (legacy && ts <= legacy.before) consume(remaining[rec.day]?.[rec.source] ?? {}, rec);
    const sessionKey = `${rec.source}:${rec.session}`;
    if (rec.source === 'antigravity' && rec.evidence?.antigravityMetadataAt !== undefined) {
      const prior = metadata.get(sessionKey);
      metadata.set(sessionKey, prior ? preferredMetadata(prior, rec)! : rec);
    }
    const older = rec.session ? remainingSessions[sessionKey] : undefined;
    if (older && ts <= older.last) consume(older.days[rec.day] ?? {}, rec);
    if (!rec.session || hiddenSessions.has(sessionKey)) continue;
    const s = (sessions[sessionKey] ??= { source: rec.source, id: rec.session, first: ts, last: ts, days: {} });
    s.first = Math.min(s.first, ts); s.last = Math.max(s.last, ts);
    // Records arrive in id order, so `>=` lets the greater id win a tie on time.
    const at = labelledAt.get(sessionKey) ?? labelledAt.set(sessionKey, { title: -Infinity, project: -Infinity }).get(sessionKey)!;
    if (rec.title && ts >= at.title) { s.title = rec.title; at.title = ts; }
    if (rec.project && ts >= at.project) { s.project = rec.project; at.project = ts; }
    const sb = ((s.days[rec.day] ??= {})[key] ??= emptyBucket());
    addAccounting(sb, { requests: 1, ...rec.tokens });
  }
  for (const [day, sources] of Object.entries(remaining)) for (const [source, models] of Object.entries(sources)) {
    for (const [model, value] of Object.entries(models ?? {})) {
      const bucket = (((days[day] ??= {})[source as Source] ??= {})[model] ??= emptyBucket());
      addAccounting(bucket, value);
    }
  }
  // What an older store knew of a session and the logs no longer show: the session stays, with what is left of its totals.
  for (const key of Object.keys(remainingSessions).sort(compareCodeUnits)) {
    const old = remainingSessions[key];
    if (hiddenSessions.has(key)) continue;
    const left = Object.entries(old.days).flatMap(([day, models]) => Object.entries(models).filter(([, value]) => COUNTERS.some(k => value[k] > 0)).map(([model, value]) => ({ day, model, value })));
    if (!left.length) continue;
    const s = (sessions[key] ??= { source: old.source, id: old.id, first: old.first, last: old.last, days: {} });
    s.first = Math.min(s.first, old.first); s.last = Math.max(s.last, old.last);
    if (old.title && !s.title) s.title = old.title;
    if (old.project && !s.project) s.project = old.project;
    for (const { day, model, value } of left) {
      const sb = ((s.days[day] ??= {})[model] ??= emptyBucket());
      addAccounting(sb, value);
    }
  }
  // Session metadata is authoritative across requests, including old requests
  // reintroduced by an import after the current metadata was collected.
  for (const [key, rec] of metadata) {
    const session = sessions[key];
    if (!session) continue;
    if (rec.title !== undefined) session.title = rec.title; else delete session.title;
    if (rec.project !== undefined) session.project = rec.project; else delete session.project;
  }
  return { days, sessions, firstDay: Object.keys(days).sort()[0] };
}

/** What is wrong with a persisted or freshly read accounting fact, or undefined when it is sound. The wording never echoes the data. */
export function usageRecordProblem(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const r = value as UsageRecord;
  if (r.id !== id || !id || !safeKey(id)) return 'unusable id';
  if (!SOURCES.includes(r.source)) return 'unknown source';
  if (typeof r.day !== 'string' || !isDay(r.day)) return 'invalid day';
  if (typeof r.model !== 'string' || !r.model || !safeKey(r.model)) return 'invalid model';
  if (!r.tokens) return 'missing token counts';
  if (!TOKEN_KEYS.every(k => Number.isSafeInteger(r.tokens[k]) && r.tokens[k] >= 0)) return 'token counts must be non-negative integers';
  if (r.ts !== undefined && !isTime(r.ts)) return 'invalid timestamp';
  for (const key of ['session', 'title', 'project'] as const) if (r[key] !== undefined && typeof r[key] !== 'string') return `invalid ${key}`;
  if (r.provider !== undefined && (typeof r.provider !== 'string' || !/^[A-Za-z0-9][\w.:/@+-]{0,99}$/.test(r.provider) || r.provider in Object.prototype)) return 'invalid provider';
  if (r.source === 'dsh' && (!Number.isSafeInteger(r.ts) || r.ts! < 0 || r.ts! > 8640000000000000)) return 'invalid timestamp';
  const e = r.evidence;
  if (e?.codexTotal !== undefined && (r.source !== 'codex' || !isSafeSessionId(r.session) || !isCount(e.codexTotal)
    || e.codexTotal === 0 || !r.id.startsWith('codex:') || r.id.startsWith('codex:count:'))) return 'invalid Codex total';
  if (e?.codexTurn !== undefined && (r.source !== 'codex' || !isSafeSessionId(e.codexTurn))) return 'invalid Codex turn';
  if (e?.codexForkFrom !== undefined && (r.source !== 'codex' || !isSafeSessionId(e.codexForkFrom) || !r.id.startsWith('codex:count:'))) return 'invalid Codex fork';
  if (e?.codexAlias !== undefined && (r.source !== 'codex' || r.id.startsWith('codex:count:') || !isSafeSessionId(r.session)
    || !isObject(e.codexAlias) || !isCount(e.codexAlias.total) || e.codexAlias.total === 0 || !Number.isFinite(e.codexAlias.timestamp))) return 'invalid Codex alias';
  if (e?.antigravityModel !== undefined && (r.source !== 'antigravity' || !isObject(e.antigravityModel) ||
    !['transcript', 'database'].includes(e.antigravityModel.kind) || !Number.isFinite(e.antigravityModel.revision) || !isCount(e.antigravityModel.parserVersion))) return 'invalid Antigravity model evidence';
  if (e?.antigravityMetadataAt !== undefined && (r.source !== 'antigravity' || !isTime(e.antigravityMetadataAt))) return 'invalid Antigravity metadata evidence';
  if (e?.dshCall !== undefined) {
    const call = e.dshCall;
    if (r.source !== 'dsh' || !isSafeSessionId(r.session) || !isObject(call) || call.version !== 1 || !Array.isArray(call.sequences)
      || !call.sequences.length || !call.sequences.every((seq, i, all) => isCount(seq) && (i === 0 || seq > all[i - 1]))
      || r.id !== 'dsh:' + r.session + ':' + call.sequences[0]) return 'invalid DSH call evidence';
  }
  if (e && !(['transcript', 'database'].includes(e.kind) && Number.isFinite(e.revision) && Number.isSafeInteger(e.parserVersion) && e.parserVersion >= 1 && (e.rawModel === undefined || typeof e.rawModel === 'string'))) return 'invalid evidence';
}

/** Validate persisted accounting facts before any summary or recovery touches them. */
export function isUsageRecord(value: unknown, id: string): value is UsageRecord {
  return usageRecordProblem(value, id) === undefined;
}
