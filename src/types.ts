/** The tools whose logs this extension reads on this machine. */
/** A conversation whose log was written to within this window is active: 10 minutes. */
export const ACTIVE_WINDOW_MS = 10 * 60_000;

export const SCANNED_SOURCES = ['antigravity', 'dsh', 'claude', 'codex'] as const;
export type ScannedSource = typeof SCANNED_SOURCES[number];
/** Every tool the ledger holds. Cursor keeps no usage on this machine, so its records come from a ledger that is brought in, not from a scan. */
export const SOURCES = [...SCANNED_SOURCES, 'cursor'] as const;
export type Source = typeof SOURCES[number];
export const SOURCE_LABELS: Record<Source, string> = { antigravity: 'Antigravity', dsh: 'DSH', claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
export const isScanned = (source: Source): source is ScannedSource => (SCANNED_SOURCES as readonly string[]).includes(source);

export interface Tokens {
  input: number;
  cacheRead: number;
  /** Short-lived cache writes, when the source reports them. */
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}
export const TOKEN_KEYS: readonly (keyof Tokens)[] = ['input', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'output'];

export interface TokenBucket extends Tokens {
  requests: number;
}

export type DayRecord = Partial<Record<Source, Record<string, TokenBucket>>>;

export interface UsageRecord {
  id: string;
  /** Provenance never includes conversation text. Revision is the source observation time. */
  evidence?: {
    kind: 'transcript' | 'database'; revision: number; parserVersion: number; rawModel?: string;
    /** The model observation when it came from a different Antigravity record than the counters. */
    antigravityModel?: { kind: 'transcript' | 'database'; revision: number; parserVersion: number };
    /** Verified settlement identities for one DSH call, retained across archive recovery. */
    dshCall?: { version: 1; sequences: number[] };
    /** Cumulative thread total that ties a Codex response to its compatibility event. */
    codexTotal?: number;
    codexTurn?: string;
    codexForkFrom?: string;
    codexAlias?: { total: number; timestamp: number };
  };
  source: Source;
  provider?: string;
  day: string;
  model: string;
  tokens: Tokens;
  /** Log session the request belongs to. Requests without one are still priced, just not listed under a session. */
  session?: string;
  /** Human-readable title of the conversation / session. */
  title?: string;
  /** Last folder of the session's working directory. */
  project?: string;
  /** Request time, epoch ms. */
  ts?: number;
}

/** Token totals of one session, per UTC day and model, so any month can be priced later. */
export interface SessionRecord {
  source: Source;
  id: string;
  title?: string;
  project?: string;
  first: number;
  last: number;
  days: Record<string, Record<string, TokenBucket>>;
}

export function emptyBucket(): TokenBucket {
  return { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 };
}

export function addBucket(target: TokenBucket, src: TokenBucket): void {
  target.requests += src.requests;
  for (const k of TOKEN_KEYS) target[k] += src[k];
}
