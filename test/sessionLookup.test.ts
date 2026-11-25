import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { FileState } from '../src/collectors/lines';
import { findSessionLog } from '../src/sessionInfo';
import { temporaryDirectory } from './temp';

const state: FileState = { size: 1, mtimeMs: 1, offset: 1 };

function countListings() {
  const fsPromises = require('node:fs').promises as { readdir: (...args: unknown[]) => Promise<unknown> };
  const real = fsPromises.readdir;
  const counter = { reads: 0, stop: () => { fsPromises.readdir = real; } };
  fsPromises.readdir = (...args: unknown[]) => { counter.reads++; return real.apply(fsPromises, args); };
  return counter;
}

test('findSessionLog takes a Claude log from the recorded states before walking the folders', async () => {
  const root = await temporaryDirectory('lookup-claude-');
  const claudeHome = path.join(root, 'claude');
  const first = path.join(claudeHome, 'projects', 'a', 'session-1.jsonl');
  const second = path.join(claudeHome, 'projects', 'b', 'session-1.jsonl');
  for (const file of [first, second]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}\n');
  }
  const homes = { claudeHome };
  const listings = countListings();
  try {
    assert.equal(await findSessionLog('claude', 'session-1', '', homes, { [second]: state }), second);
    assert.equal(listings.reads, 0);

    assert.equal(await findSessionLog('claude', 'session-1', '', homes), first);
    assert.ok(listings.reads > 0);

    const outside = path.join(root, 'elsewhere', 'session-1.jsonl');
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await fs.writeFile(outside, '{}\n');
    assert.equal(await findSessionLog('claude', 'session-1', '', homes, { [outside]: state, [path.join(claudeHome, 'projects', 'a', 'other.jsonl')]: state }), first);

    await fs.rm(second);
    listings.reads = 0;
    assert.equal(await findSessionLog('claude', 'session-1', '', homes, { [second]: state }), first);
    assert.ok(listings.reads > 0);
    await fs.rm(path.dirname(first), { recursive: true });
    assert.equal(await findSessionLog('claude', 'session-1', '', homes, { [first]: state, [second]: state }), undefined);
  } finally { listings.stop(); }
});

test('findSessionLog takes a Codex rollout from the recorded states, and finds one that moved to the archive by walking', async () => {
  const root = await temporaryDirectory('lookup-codex-');
  const codexHome = path.join(root, 'codex');
  const active = path.join(codexHome, 'sessions', '2026', '11', '22', 'rollout-2026-11-22T10-00-00-codex-one.jsonl');
  const archived = path.join(codexHome, 'archived_sessions', path.basename(active));
  for (const file of [active, archived]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}\n');
  }
  const homes = { codexHome };
  const listings = countListings();
  try {
    assert.equal(await findSessionLog('codex', 'codex-one', '', homes, { [archived]: state }), archived);
    assert.equal(listings.reads, 0);
    assert.equal(await findSessionLog('codex', 'codex-one', '', homes), active);

    await fs.rm(active);
    assert.equal(await findSessionLog('codex', 'codex-one', '', homes, { [active]: state }), archived);
    assert.equal(await findSessionLog('codex', 'codex-two', '', homes, { [active]: state }), undefined);
    assert.equal(await findSessionLog('codex', '../codex-one', '', homes, { [archived]: state }), undefined);
  } finally { listings.stop(); }
});
