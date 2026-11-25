#!/usr/bin/env node
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

// Run after npm test. Synthetic inputs only; never opens the user's data roots.
const require = createRequire(import.meta.url);
let readNewLines, UsageStore, collectSessionInfos;
try {
  ({ readNewLines } = require('../out/src/collectors/lines.js'));
  ({ UsageStore } = require('../out/src/store.js'));
  ({ collectSessionInfos } = require('../out/src/offlineExport.js'));
} catch {
  throw new Error('Run npm test before node tools/benchmark.mjs');
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'dock-benchmark-'));
const report = { node: process.version, platform: process.platform, arch: process.arch, cpus: os.availableParallelism?.() ?? os.cpus().length,
  measuredAt: new Date().toISOString(), jsonl: [], ledger: [], missingLogExport: [] };
const elapsed = started => Number((performance.now() - started).toFixed(2));
const mib = bytes => Number((bytes / 1024 ** 2).toFixed(2));

try {
  for (const sizeMiB of [1, 8, 32]) {
    const file = path.join(scratch, `log-${sizeMiB}.jsonl`);
    const line = JSON.stringify({ n: 0, padding: 'x'.repeat(1000) }) + '\n';
    const lines = Math.ceil(sizeMiB * 1024 ** 2 / Buffer.byteLength(line));
    await fs.writeFile(file, line.repeat(lines));
    const initialBytes = (await fs.stat(file)).size;
    let callbacks = 0, bytesRead = 0;
    const open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      handle.read = async (...readArgs) => { const result = await read(...readArgs); bytesRead += result.bytesRead; return result; };
      return handle;
    };
    try {
      const parse = text => { JSON.parse(text); callbacks++; };
      let started = performance.now();
      let state = await readNewLines(file, undefined, parse);
      const coldMs = elapsed(started);
      assert.equal(callbacks, lines);
      await fs.appendFile(file, '{"tail":true}\n');
      callbacks = 0; bytesRead = 0; started = performance.now();
      state = await readNewLines(file, state, parse);
      const appendMs = elapsed(started), appendBytesRead = bytesRead;
      assert.equal(callbacks, 1);
      // Same-size rewrite must replay; truncation and deletion must not reuse a cursor.
      const handle = await open(file, 'r+');
      await handle.write(Buffer.from('1'), 0, 1, 5); await handle.close();
      callbacks = 0; started = performance.now();
      state = await readNewLines(file, state, parse);
      const rewriteMs = elapsed(started);
      assert.equal(callbacks, lines + 1);
      await fs.writeFile(file, '{}\n');
      callbacks = 0; state = await readNewLines(file, state, parse);
      assert.equal(callbacks, 1);
      await fs.rm(file);
      await assert.rejects(readNewLines(file, state, parse), { code: 'ENOENT' });
      report.jsonl.push({ initialMiB: mib(initialBytes), coldMs, appendMs, appendBytesRead, rewriteMs });
    } finally { fs.open = open; }
  }

  for (const count of [1_000, 10_000, 50_000]) {
    const file = path.join(scratch, `ledger-${count}`, 'usage-v3.json');
    const store = await UsageStore.load(file);
    const records = Array.from({ length: count }, (_, i) => ({ id: `claude:r-${i}`, source: 'claude', session: `s-${Math.floor(i / 10)}`,
      day: '2026-11-16', ts: 1794823200000 + i, model: 'claude-sonnet-5-5',
      tokens: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cacheWrite1h: 0 } }));
    let started = performance.now();
    await store.transaction(async checkpoint => { store.addRecords(records); await checkpoint(); await store.archive(); });
    const initialWriteMs = elapsed(started);
    started = performance.now();
    const loaded = await UsageStore.load(file);
    const loadAndAggregateMs = elapsed(started);
    assert.equal(Object.keys(loaded.data.records).length, count);
    started = performance.now();
    await loaded.transaction(async checkpoint => { loaded.add({ ...records[0], id: 'claude:appended' }); await checkpoint(); await loaded.archive(); });
    report.ledger.push({ records: count, initialWriteMs, loadAndAggregateMs, appendTransactionMs: elapsed(started),
      workingMiB: mib((await fs.stat(file)).size), archiveMiB: mib((await fs.stat(path.join(path.dirname(file), 'archive', 'history-ledger-v3.json'))).size), rssAfterMiB: mib(process.memoryUsage().rss) });
  }

  const claudeHome = path.join(scratch, 'claude');
  const project = path.join(claudeHome, 'projects', 'fixture');
  await fs.mkdir(project, { recursive: true });
  for (let i = 0; i < 100; i++) await fs.writeFile(path.join(project, `unrelated-${i}.jsonl`), '{}\n');
  for (const count of [20, 100, 500]) {
    const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [`claude:missing-${i}`,
      { source: 'claude', id: `missing-${i}`, first: 1794823200000, last: 1794823200000, days: {} }]));
    const readdir = fs.readdir;
    let directoryReads = 0;
    fs.readdir = async (...args) => { directoryReads++; return readdir(...args); };
    const started = performance.now();
    try {
      const infos = await collectSessionInfos(sessions, {}, { claudeHome, codexHome: path.join(scratch, 'codex'), antigravityHome: path.join(scratch, 'agy'), dshHome: path.join(scratch, 'dsh') });
      assert.equal(Object.keys(infos).length, 0);
      report.missingLogExport.push({ sessions: count, elapsedMs: elapsed(started), directoryReads });
    } finally { fs.readdir = readdir; }
  }
  report.peakRssMiB = mib(process.resourceUsage().maxRSS * 1024);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
