import { MAX_TIME_MS, projectName, safeModel } from './lines';
import { isSafeSessionId } from '../sessionId';
import { UsageRecord } from '../types';

export const DSH_PARSER_VERSION = 4;

/** A problem in the log's content rather than in the runtime or the disk: the same bytes always fail the same way. */
export class DshContentError extends Error {}

export interface DshResult {
  records: UsageRecord[];
  problems: string[];
  session: string;
  title?: string;
  firstPrompt?: string;
}

const validCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const validTime = (n: unknown): n is number => validCount(n) && n <= MAX_TIME_MS;
const route = (n: unknown): string | undefined => typeof n === 'string' && safeModel(n) === n ? n : undefined;

/** Folds only accounting facts; raw messages/streams are discarded one line at a time. */
export class DshParser {
  private header: any;
  private records: UsageRecord[] = [];
  private problems: string[] = [];
  private last?: { turn: number; step: number; first: number; ts: number; sequences: number[]; index?: number };
  private provider?: string;
  private model?: string;
  private title?: string;
  private firstPrompt?: string;
  private lastSeq = -1;
  private boundary = false;
  private badEnvelope = false;

  constructor(private readonly revision: number, private readonly inspect = false) {}

  line(text: string): void {
    if (!text.trim()) return;
    let e: any;
    try { e = JSON.parse(text); }
    catch { this.problems.push('Malformed JSON line'); this.badEnvelope = true; this.last = undefined; return; }
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      if (!this.header) throw new DshContentError('Unsupported or invalid DSH v4 session header');
      this.problems.push('Invalid event envelope'); this.badEnvelope = true; this.last = undefined; return;
    }
    if (!this.header) {
      if (e.type !== 'session' || e.version !== 4 || !isSafeSessionId(e.id) || !validTime(e.createdAt)) throw new DshContentError('Unsupported or invalid DSH v4 session header');
      this.header = e;
      return;
    }
    if (!validCount(e.seq) || e.seq !== this.lastSeq + 1 || typeof e.type !== 'string' || !validTime(e.time) || !e.data || typeof e.data !== 'object') {
      this.problems.push('Invalid event envelope'); this.badEnvelope = true; this.last = undefined; return;
    }
    this.lastSeq = e.seq;
    const d = e.data;
    if (e.type === 'session/end-seed' && d.inherited === true) {
      this.records = []; this.last = undefined; this.boundary = true;
      return;
    }
    if (e.type === 'request/header') {
      this.provider = route(d.header?.config?.provider);
      this.model = route(d.header?.config?.model);
    }
    if (e.type === 'session/title' && typeof d.title === 'string') this.title = d.title.slice(0, 500);
    if (this.inspect && !this.firstPrompt && e.type === 'user/message' && d.source?.kind === 'user') {
      const text = typeof d.content === 'string' ? d.content : Array.isArray(d.content) ? d.content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join(' ') : '';
      this.firstPrompt = text.trim().slice(0, 600) || undefined;
    }
    if (e.type === 'llm/retry-started') {
      if (this.last?.turn === d.turn && this.last?.step === d.step) this.last = undefined;
      return;
    }
    if (e.type !== 'assistant/message' && e.type !== 'assistant/attempt') return;
    let sample = e.type === 'assistant/message' ? d.usage : undefined;
    if (sample === undefined && Array.isArray(d.stream)) {
      for (const r of d.stream) if (r?.type === 'chunk' && r.chunk?.type === 'usage') sample = r.chunk.usage;
    }
    if (sample === undefined) return;
    if (!validCount(d.turn) || !validCount(d.step)) {
      this.problems.push('Invalid usage counters or call position'); this.last = undefined; return;
    }
    if (this.last?.turn !== d.turn || this.last?.step !== d.step) this.last = { turn: d.turn, step: d.step, first: e.seq, ts: e.time, sequences: [] };
    const call = this.last!;
    call.sequences.push(e.seq);
    const identity = { version: 1 as const, sequences: [...call.sequences] };
    if (call.index !== undefined) this.records[call.index].evidence!.dshCall = identity;
    if (!sample || typeof sample !== 'object' || !validCount(sample.inputTokens) || !validCount(sample.outputTokens)
      || (sample.cacheReadTokens !== undefined && !validCount(sample.cacheReadTokens))
      || (sample.cacheWriteTokens !== undefined && !validCount(sample.cacheWriteTokens))) {
      this.problems.push('Invalid usage counters or call position'); return;
    }
    const tokens = { input: sample.inputTokens, output: sample.outputTokens, cacheRead: sample.cacheReadTokens ?? 0, cacheWrite: sample.cacheWriteTokens ?? 0, cacheWrite1h: 0 };
    if (sample.totalTokens !== undefined && (!validCount(sample.totalTokens) || sample.totalTokens !== tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite)) this.problems.push('Inconsistent provider totalTokens (not added to usage)');
    const previous = call.index;
    const source = e.type === 'assistant/message' ? d.message?.source : undefined;
    const prior = previous === undefined ? undefined : this.records[previous];
    const suppliedProvider = route(source?.provider);
    const suppliedModel = route(source?.model);
    const compatible = prior && (source?.provider == null || suppliedProvider === prior.provider) && (source?.model == null || suppliedModel === prior.model);
    const provider = e.type === 'assistant/message' ? suppliedProvider ?? (compatible ? prior.provider : undefined) : this.provider;
    const model = (e.type === 'assistant/message' ? suppliedModel ?? (compatible ? prior.model : undefined) : this.model) ?? 'unknown-model';
    const ts = call.ts;
    const rec: UsageRecord = {
      id: 'dsh:' + this.header.id + ':' + call.first, source: 'dsh', provider,
      session: this.header.id, project: projectName(this.header.cwd),
      model, day: new Date(ts).toISOString().slice(0, 10), ts, tokens,
      evidence: { kind: 'transcript', revision: this.revision, parserVersion: DSH_PARSER_VERSION, dshCall: identity },
    };
    if (previous === undefined) { this.records.push(rec); call.index = this.records.length - 1; }
    else this.records[previous] = rec;
  }

  finish(): DshResult {
    if (!this.header) throw new DshContentError('Missing DSH session header');
    if ((this.header.isSeeded && !this.boundary) || this.badEnvelope) throw new DshContentError('Cannot establish complete DSH event/fork boundary');
    return { session: this.header.id, records: this.records.map(r => ({ ...r, title: this.title })), problems: this.problems, title: this.title, firstPrompt: this.firstPrompt };
  }
}
