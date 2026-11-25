import { DayRecord, SessionRecord, Source, SOURCES, TOKEN_KEYS, TokenBucket } from './types';

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const safeKey = (key: string): boolean => !(key in Object.prototype) && key !== 'prototype';
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** 1970-01-01 to 9999-12-31, the instants that have a four-digit year. */
const MAX_TIME_MS = 253402300799999;
export const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME_MS;

/** Ordering by UTF-16 code unit, so a result never depends on the process locale. */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function isDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(day + 'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}

export function isBucket(value: unknown): value is TokenBucket {
  return isObject(value) && ['requests', ...TOKEN_KEYS].every(k => Object.prototype.hasOwnProperty.call(value, k) && isCount(value[k]));
}

export function isByModel(value: unknown): value is Record<string, TokenBucket> {
  return isObject(value) && Object.entries(value).every(([key, bucket]) => safeKey(key) && isBucket(bucket));
}

export function isDays(value: unknown): value is Record<string, DayRecord> {
  return isObject(value) && Object.entries(value).every(([day, sources]) => isDay(day) && isObject(sources)
    && Object.entries(sources).every(([source, models]) => SOURCES.includes(source as Source) && isByModel(models)));
}

/** A session total kept under `<source>:<id>`, as another store wrote it: the key must say what the entry is, and every day must be a real one. */
export function isSessionTotal(key: string, value: unknown): value is SessionRecord {
  return safeKey(key) && isObject(value)
    && SOURCES.includes(value.source as Source) && typeof value.id === 'string' && value.id !== '' && key === `${value.source}:${value.id}`
    && isTime(value.first) && isTime(value.last)
    && (value.title === undefined || typeof value.title === 'string') && (value.project === undefined || typeof value.project === 'string')
    && isObject(value.days) && Object.entries(value.days).every(([day, byModel]) => isDay(day) && isByModel(byModel));
}

export const isSessionTotals = (value: unknown): value is Record<string, SessionRecord> =>
  isObject(value) && Object.entries(value).every(([key, session]) => isSessionTotal(key, session));

export function isLegacy(value: unknown): value is { days: Record<string, DayRecord>; before: number; sessions?: Record<string, SessionRecord> } {
  return isObject(value) && typeof value.before === 'number' && Number.isFinite(value.before) && isDays(value.days)
    && (value.sessions === undefined || isSessionTotals(value.sessions));
}
