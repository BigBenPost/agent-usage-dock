import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type { FileState } from '../src/collectors/lines';
import { ACTIVE_WINDOW_MS, activeSessionKeys } from '../src/sessionActivity';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const state = (agoMs: number): FileState => ({ size: 1, mtimeMs: NOW - agoMs, offset: 1 });

test('activeSessionKeys marks an Antigravity conversation written to within the active window', () => {
  const files: Record<string, FileState> = {
    [path.join('brain', 'conv-active', '.system_generated', 'logs', 'transcript.jsonl')]: state(60_000),
    [path.join('brain', 'conv-idle', '.system_generated', 'logs', 'transcript.jsonl')]: state(ACTIVE_WINDOW_MS + 10_000),
  };
  const active = activeSessionKeys(files, NOW);
  assert.equal(active.has('antigravity:conv-active'), true);
  assert.equal(active.has('antigravity:conv-idle'), false);
});

test('activeSessionKeys includes recent conversation databases and excludes idle ones', () => {
  const files: Record<string, FileState> = {
    [path.join('conversations', 'conv-active.db')]: state(60_000),
    [path.join('conversations', 'conv-idle.db')]: state(ACTIVE_WINDOW_MS + 10_000),
  };
  assert.deepEqual([...activeSessionKeys(files, NOW)], ['antigravity:conv-active']);
});
