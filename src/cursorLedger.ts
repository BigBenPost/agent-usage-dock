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

/**
 * The id a request of Cursor is kept under when it joins records already held. Requests with the same time, model and counts share
 * a base id and take `:1`, `:2`, ... after it in the order the ledger lists them, and a later snapshot may list them in another
 * order. A request whose id is held by another conversation moves to the next id that is free or already holds its own conversation,
 * so conversations are never merged or swapped. A copy that does not know its conversation joins whatever holds the id.
 */
export function cursorSlot(held: Record<string, UsageRecord>, rec: UsageRecord): string {
  const base = CURSOR_ID.exec(rec.id)?.[1];
  const prior = held[rec.id];
  if (!base || !prior || !prior.session || !rec.session || prior.session === rec.session) return rec.id;
  for (let n = 0; ; n++) {
    const id = n ? `${base}:${n}` : base;
    const other = held[id];
    if (!other || !other.session || other.session === rec.session) return id;
  }
}
