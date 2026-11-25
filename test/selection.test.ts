import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { DayRecord, emptyBucket, SessionRecord, TokenBucket } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg: Config = { dashboardTheme: 'light', timeZone: 'UTC', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', budgetLimit: 100, warningThreshold: 0.75, criticalThreshold: 0.9, pollIntervalSeconds: 60, correctionFactor: 1, rates: {} };

const bucket = (output: number): TokenBucket => ({ ...emptyBucket(), requests: 1, output });
const days: Record<string, DayRecord> = { '2026-10-21': { antigravity: { 'gemini-1.5-flash': bucket(2e6) } } };

function session(id: string, project: string): SessionRecord {
  return { source: 'antigravity', id, project, first: Date.parse('2026-10-21T09:00:00Z'), last: Date.parse('2026-10-21T10:00:00Z'), days: { '2026-10-21': { 'gemini-1.5-flash': bucket(1e6) } } };
}

const sessions = {
  'antigravity:live': session('live', 'live-project'),
  'antigravity:old': session('old', '<img src=x onerror=alert(1)>'),
};
const body = (input: Partial<Parameters<typeof summarize>[0]> = {}): string => renderBody(summarize({ days, sessions, active: new Set(['antigravity:live']), ...input }, new Pricing(), NOW), cfg);
const card = (html: string, key: string): string => html.match(new RegExp(`<article class="scard[^"]*"[^>]*data-key="${key}"[\\s\\S]*?</article>`))?.[0] ?? '';

test('a card escapes what the log called its project', () => {
  const idle = card(body(), 'antigravity:old');
  assert.ok(idle.length > 0);
  assert.match(idle, /&#60;img src=x onerror=alert\(1\)&#62;/);
  assert.doesNotMatch(idle, /<img src=x/);
});

test('only a session that looks in use says so', () => {
  const html = body();
  assert.match(card(html, 'antigravity:live'), /<b class="inuse">In use<\/b>/);
  assert.doesNotMatch(card(html, 'antigravity:old'), /In use/);
  assert.doesNotMatch(card(body({ active: new Set() }), 'antigravity:live'), /In use/);
});
