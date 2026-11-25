import { isSafeSessionId } from '../sessionId';
import { TOKEN_KEYS, type Tokens, type UsageRecord } from '../types';
import { isCount, isObject } from '../validation';
import { FileState, num, projectName, safeModel, timestampMs, UNKNOWN_MODEL, utcDay } from './lines';

export const codexCountId = (session: string, total: number): string => `codex:count:${session}:${total}`;
const USAGE_EVENTS = /"(session_meta|turn_context|token_usage_record|token_count)"/;

function readUsage(usage: unknown): Tokens | undefined {
  if (!isObject(usage) || !isCount(usage.input_tokens) || !isCount(usage.output_tokens)) return undefined;
  if ([usage.cached_input_tokens, usage.cache_write_input_tokens].some(value => value != null && !isCount(value))) return undefined;
  const cacheRead = num(usage.cached_input_tokens);
  const cacheWrite = num(usage.cache_write_input_tokens);
  if (cacheRead + cacheWrite > usage.input_tokens) return undefined;
  return {
    input: usage.input_tokens - cacheRead - cacheWrite,
    cacheRead,
    cacheWrite,
    cacheWrite1h: 0,
    output: usage.output_tokens,
  };
}

/** Response records carry stable ids. Older rollouts expose usage only through token_count snapshots. */
export function parseCodexLine(line: string, state: FileState): UsageRecord | undefined {
  if (!USAGE_EVENTS.test(line)) return undefined;
  let entry;
  try { entry = JSON.parse(line); } catch { throw new Error('Malformed Codex usage or context line'); }
  const p = entry?.payload;
  if (!isObject(p)) {
    if (entry?.type === 'token_usage_record') throw new Error('Codex response usage has no payload');
    return undefined;
  }
  if (entry.type === 'session_meta') {
    const session = [p.id, p.session_id].find(isSafeSessionId);
    if (session && session !== state.session) {
      state.session = session;
      state.codexTotal = undefined;
      state.codexTurn = undefined;
      state.model = undefined;
    }
    state.codexForkFrom = isSafeSessionId(p.forked_from_id) && p.forked_from_id !== session ? p.forked_from_id : undefined;
    state.codexForkAt = state.codexForkFrom ? timestampMs(entry.timestamp) ?? timestampMs(p.timestamp) : undefined;
    state.source = 'codex';
    state.project = projectName(p.cwd) ?? state.project;
    return undefined;
  }
  if (entry.type === 'turn_context') {
    if (typeof p.model === 'string') state.model = safeModel(p.model);
    state.codexTurn = isSafeSessionId(p.turn_id) ? p.turn_id : undefined;
    state.project ??= projectName(p.cwd);
    return undefined;
  }

  const ts = timestampMs(entry.timestamp);
  const day = utcDay(entry.timestamp);
  const compatibility = entry.type === 'event_msg' && p.type === 'token_count' && p.info != null;
  if (entry.type !== 'token_usage_record' && !compatibility) return undefined;
  if (ts === undefined || !day) throw new Error('Missing timestamp on Codex usage');
  const model = state.model ?? UNKNOWN_MODEL;
  const project = state.project;
  const codexTurn = isSafeSessionId(p.turn_id) ? p.turn_id : state.codexTurn;
  if (entry.type === 'token_usage_record') {
    const id = isSafeSessionId(p.response_id) ? p.response_id : isSafeSessionId(p.turn_id) ? `${p.turn_id}@${ts}` : undefined;
    const tokens = readUsage(p.usage);
    if (!id || !tokens) throw new Error('Invalid Codex response usage or identity');
    const session = isSafeSessionId(p.thread_id) ? p.thread_id : state.session;
    const total = isObject(p.thread_token_usage) ? p.thread_token_usage.total_tokens : undefined;
    const evidence = { kind: 'transcript' as const, revision: ts, parserVersion: 2, codexTurn, codexTotal: session && isCount(total) && total > 0 ? total : undefined };
    state.source = 'codex';
    state.session ??= session;
    return { id: `codex:${id}`, source: 'codex', day, model, tokens, session, project, ts, evidence };
  }
  if (!isObject(p.info)) throw new Error('Invalid Codex compatibility usage');
  // Some quota-only events carry limits but no request usage.
  if (p.info.last_token_usage == null) return undefined;
  const total = isObject(p.info.total_token_usage) ? p.info.total_token_usage.total_tokens : undefined;
  const tokens = readUsage(p.info.last_token_usage);
  if (!tokens || !state.session || !isCount(total)) throw new Error('Invalid Codex compatibility counters or thread identity');
  if (total === 0 || total === state.codexTotal) return undefined;
  state.codexTotal = total;
  const session = state.session;
  const codexForkFrom = state.codexForkAt === undefined || ts < state.codexForkAt ? state.codexForkFrom : undefined;
  const evidence = { kind: 'transcript' as const, revision: 0, parserVersion: 2, codexTurn, codexForkFrom };
  return { id: codexCountId(session, total), source: 'codex', day, model, tokens, session, project, ts, evidence };
}

const isCounter = (record: UsageRecord) => record.id.startsWith('codex:count:');
const sameUsage = (a: UsageRecord, b: UsageRecord) => TOKEN_KEYS.every(key => a.tokens[key] === b.tokens[key]);
const counterTotal = (record: UsageRecord): number => Number(record.id.slice(record.id.lastIndexOf(':') + 1));
/** The cumulative total a response is tied to: that of the counter it was paired with, else the one its own record states. */
const responseTotal = (record: UsageRecord): number | undefined => record.evidence?.codexAlias?.total ?? record.evidence?.codexTotal;
/** A response stands for one request: it cannot be paired with a counter of another cumulative total. */
const fits = (counter: UsageRecord, response: UsageRecord): boolean => {
  const own = responseTotal(response);
  return own === undefined || own === counterTotal(counter);
};

export function codexAliases(records: Record<string, UsageRecord>, problems?: string[]) {
  const candidates = Object.values(records).filter(record => record.source === 'codex' && record.session);
  const aliases = new Set<string>();
  const verified = new Map<string, NonNullable<NonNullable<UsageRecord['evidence']>['codexAlias']>>();
  if (!candidates.some(isCounter)) return { aliases, verified };
  const paired = new Set<string>();
  const priorAliases = new Map<string, UsageRecord>();
  const originals = new Map<string, UsageRecord[]>();
  const original = (total: number, timestamp: number | undefined, record: UsageRecord) => {
    const key = `${total}\0${timestamp}`;
    originals.set(key, [...originals.get(key) ?? [], record]);
  };
  for (const record of candidates) {
    if (isCounter(record) && !record.evidence?.codexForkFrom) original(counterTotal(record), record.ts, record);
    const alias = record.evidence?.codexAlias;
    if (!alias) continue;
    const counter = codexCountId(record.session!, alias.total);
    priorAliases.set(counter, record);
    original(alias.total, alias.timestamp, record);
    if (records[counter]?.ts === alias.timestamp) {
      aliases.add(counter);
      paired.add(record.id);
    }
  }
  // A fork replays the events of the thread it came from, and of that thread's own ancestors: a replayed counter counts only where
  // the original is no longer in the ledger, so the original is looked for under the parent first and then under any other thread.
  for (const record of candidates) {
    const parent = record.evidence?.codexForkFrom;
    if (!parent || !isCounter(record)) continue;
    const total = counterTotal(record);
    const parentId = codexCountId(parent, total);
    const counter = records[parentId];
    const response = priorAliases.get(parentId);
    if ((counter && record.ts === counter.ts && sameUsage(record, counter)) ||
        (response && record.ts === response.evidence?.codexAlias?.timestamp && sameUsage(record, response)) ||
        (originals.get(`${total}\0${record.ts}`) ?? []).some(other => other.session !== record.session && sameUsage(record, other))) aliases.add(record.id);
  }

  type Group = { counters: UsageRecord[]; responses: UsageRecord[] };
  const ambiguous = new Set<string>();
  const match = (identity: (record: UsageRecord) => string | undefined, report: boolean) => {
    const groups = new Map<string, Group>();
    for (const record of candidates) {
      if (aliases.has(record.id) || paired.has(record.id)) continue;
      const key = identity(record);
      if (key === undefined) continue;
      const id = `${record.session}\0${key}`;
      let group = groups.get(id);
      if (!group) groups.set(id, group = { counters: [], responses: [] });
      (isCounter(record) ? group.counters : group.responses).push(record);
    }
    for (const group of groups.values()) {
      const responses = group.responses.filter(response => group.counters.some(counter => fits(counter, response)));
      const counters = group.counters.filter(counter => responses.some(response => fits(counter, response)));
      if (!counters.length || !responses.length) continue;
      const [counter] = counters, [response] = responses;
      const a = counter.evidence?.codexTurn, b = response.evidence?.codexTurn;
      if (counters.length === 1 && responses.length === 1 && (!a || !b || a === b) && sameUsage(counter, response)) {
        aliases.add(counter.id);
        paired.add(response.id);
        const total = counterTotal(counter);
        if (response.evidence && isCount(total) && total > 0 && counter.ts !== undefined) verified.set(response.id, { total, timestamp: counter.ts });
      } else if (report) {
        ambiguous.add(counters[0].session!);
      }
    }
  };

  const totalKey = (record: UsageRecord) => isCounter(record) ? String(counterTotal(record)) : responseTotal(record)?.toString();
  match(totalKey, false);
  match(record => record.ts?.toString(), false);
  match(record => record.evidence?.codexTurn, true);
  match(totalKey, true);
  match(record => record.ts?.toString(), true);
  if (problems) {
    const usageKey = (record: UsageRecord) => JSON.stringify([record.session, ...TOKEN_KEYS.map(key => record.tokens[key])]);
    const unmatched = new Set(candidates.filter(record => isCounter(record) && !aliases.has(record.id)).map(usageKey));
    for (const record of candidates) {
      if (!isCounter(record) && !paired.has(record.id) && !record.evidence?.codexTotal && !record.evidence?.codexAlias && unmatched.has(usageKey(record))) {
        ambiguous.add(record.session!);
      }
    }
    for (const session of [...ambiguous].sort()) problems.push(`Ambiguous Codex response and counter overlap in session ${session}`);
  }
  return { aliases, verified };
}
