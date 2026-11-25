import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, isUsageRecord, preferredRecord } from '../src/reconcile';
import type { UsageRecord } from '../src/types';

const record = (id: string, at: number | undefined, title?: string, project?: string): UsageRecord => ({
  id, source: 'antigravity', session: 's', model: 'gemini-3.8-flash', day: '2026-11-16', ts: 1794823200000,
  title, project, tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
  evidence: { kind: 'transcript', revision: 1, parserVersion: 3, ...(at !== undefined ? { antigravityMetadataAt: at } : {}) },
});

test('Antigravity metadata merges independently of counter provenance in either order', () => {
  const old = { ...record('r', 1, 'Zulu', 'old'), evidence: { ...record('r', 1).evidence!, kind: 'database' as const, revision: 100 } };
  const renamed = record('r', 2, 'Alpha', 'new');
  for (const [a, b] of [[old, renamed], [renamed, old]]) {
    const merged = preferredRecord(a, b);
    assert.equal(merged.title, 'Alpha');
    assert.equal(merged.project, 'new');
    assert.equal(merged.evidence?.kind, 'database');
    assert.deepEqual(merged.tokens, old.tokens);
    assert.deepEqual(preferredRecord(merged, old), merged);
  }
});

test('the newest session metadata overrides stale unique imported requests, including explicit clears', () => {
  const stale = { ...record('later-request', undefined, 'Zulu', 'old'), ts: 1794823300000 };
  for (const [title, project] of [['Alpha', 'new'], [undefined, undefined]]) {
    const current = record('carrier', 2, title, project);
    for (const records of [{ current, stale }, { stale, current }]) {
      const facts = aggregate(records);
      const session = facts.sessions['antigravity:s'];
      assert.equal(session.title, title);
      assert.equal(session.project, project);
      assert.equal(facts.days['2026-11-16'].antigravity!['gemini-3.8-flash'].requests, 2);
    }
  }
});

test('Antigravity metadata evidence is optional for old records and validated on new records', () => {
  assert.equal(isUsageRecord(record('r', undefined), 'r'), true);
  assert.equal(isUsageRecord(record('r', 0), 'r'), true);
  for (const at of [-1, NaN, Infinity, 253402300800000, 'today', {}]) {
    const invalid = record('r', undefined);
    (invalid.evidence as any).antigravityMetadataAt = at;
    assert.equal(isUsageRecord(invalid, 'r'), false);
  }
  const other = { ...record('r', 1), source: 'claude' as const };
  assert.equal(isUsageRecord(other, 'r'), false);
});
