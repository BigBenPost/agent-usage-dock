import { createHash } from 'crypto';
import type { UsageRecord } from './types';
import { isCount, isObject } from './validation';

/** 1970-01-01 to 9999-12-31, the instants that have a four-digit year and so a valid accounting day. */
const MAX_TIME_MS = 253402300799999;

/**
 * The usage ledger of the cursor-usage-monitor extension (`~/.cursor-usage-monitor/usage.json`): version 1, one tuple per request,
 * `[time, model, input, output, cache read, cache write, cents charged, cents of list value, conversation]`. Cursor keeps no usage on
 * this machine, so that extension's ledger is where it can be had. What Cursor charged is not carried over: the page prices tokens at
 * list rates in every tool, and a plan's included usage would make Cursor the one tool priced another way.
 */
export const isCursorLedger = (value: unknown): value is { version: 1; events: unknown[] } =>
  isObject(value) && value.version === 1 && Array.isArray(value.events) && value.days === undefined && value.records === undefined;

/** What is wrong with one event, or undefined when it can be read as a request. */
function problemWith(event: unknown): string | undefined {
  if (!Array.isArray(event) || event.length < 8) return 'is not a usage event';
  const [time, model, ...counts] = event;
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0 || time > MAX_TIME_MS) return 'has no valid time';
  if (typeof model !== 'string' || model === '') return 'has no model';
  if (!counts.slice(0, 4).every(isCount)) return 'has token counts that are not whole numbers from 0';
  return undefined;
}

/**
 * The events as requests of Cursor. A request's id is made of its time and a digest of its model and token counts, and a counter for
 * identical ones, so reading the ledger again, or a later version of it, finds the same requests whatever their place in the file.
 * A conversation id that cannot name a session (anything but letters, digits, `_` and `-`) leaves the request without one.
 * The model keeps the name Cursor wrote. Throws, naming the event, when one cannot be read.
 */
export function cursorRecords(ledger: { events: unknown[] }): UsageRecord[] {
  const taken = new Map<string, number>();
  return ledger.events.map((event, index): UsageRecord => {
    const problem = problemWith(event);
    if (problem) throw new Error(`event ${index + 1} ${problem}`);
    const [time, model, input, output, cacheRead, cacheWrite, , , conversation] = event as [number, string, number, number, number, number, unknown, unknown, unknown];
    const digest = createHash('sha256').update([model, input, output, cacheRead, cacheWrite].join('|')).digest('hex').slice(0, 10);
    const base = `cursor:${time}:${digest}`;
    const again = taken.get(base) ?? 0;
    taken.set(base, again + 1);
    const session = typeof conversation === 'string' && /^[\w-]{1,100}$/.test(conversation) ? conversation : undefined;
    return {
      id: again ? `${base}:${again}` : base,
      source: 'cursor',
      day: new Date(time).toISOString().slice(0, 10),
      model,
      tokens: { input, cacheRead, cacheWrite, cacheWrite1h: 0, output },
      ...(session ? { session } : {}),
      ts: time,
    };
  });
}

const CURSOR_ID = /^(cursor:\d+:[0-9a-f]{10})(?::\d+)?$/;

/** One-to-one matching within an import: a held request may satisfy at most one incoming request. */
export class CursorMatcher {
  private readonly used = new Set<string>();
  private readonly groups = new Map<string, string[]>();
  constructor(private readonly held: Record<string, UsageRecord>) {
    for (const id of Object.keys(held)) {
      const base = CURSOR_ID.exec(id)?.[1];
      if (base) {
        let group = this.groups.get(base);
        if (!group) this.groups.set(base, group = []);
        group.push(id);
      }
    }
  }

  slot(rec: UsageRecord): string {
    const base = CURSOR_ID.exec(rec.id)?.[1];
    if (!base) return rec.id;
    const group = this.groups.get(base) ?? [];
    const slots = group.filter(id => !this.used.has(id));
    let id = slots.find(id => this.held[id].session === rec.session)
      ?? slots.find(id => !this.held[id].session || !rec.session);
    if (!id) {
      let n = 0;
      id = base;
      while (this.held[id] || this.used.has(id)) id = `${base}:${++n}`;
      group.push(id);
      this.groups.set(base, group);
    }
    this.used.add(id);
    return id;
  }
}
