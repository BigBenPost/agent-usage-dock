import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { scanDsh } from '../src/collectors/dsh';
import type { FileState } from '../src/collectors/lines';
import { temporaryDirectory } from './temp';

test('DSH follows contained links once, reports unsafe or broken links, keeps cursors and fails strict flush', { skip: process.platform === 'win32' }, async () => {
  const home = await temporaryDirectory('dsh-links-');
  const sessions = path.join(home, 'sessions');
  const dir = path.join(sessions, 'real');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  await fs.writeFile(file, 'fixture');
  await fs.symlink(dir, path.join(sessions, 'alias'));
  await fs.mkdir(path.join(sessions, 'file-alias'));
  await fs.symlink(file, path.join(sessions, 'file-alias', 'session.v4.jsonl.zstd'));
  let reads = 0;
  const read = async () => { reads++; return { records: [], problems: [], session: 's' }; };
  const files: Record<string, FileState> = {};
  const first = await scanDsh(home, files, undefined, read);
  assert.deepEqual(first.problems, []);
  assert.equal(reads, 1, 'one physical log is read only once');
  assert.deepEqual(Object.keys(files), [file], 'prefer the real path over aliases');
  await scanDsh(home, files, undefined, read);
  assert.equal(reads, 1);
  await scanDsh(home, JSON.parse(JSON.stringify(files)), undefined, read);
  assert.equal(reads, 1, 'fingerprints also survive a restart');

  if (!process.getuid || process.getuid() !== 0) {
    const denied = path.join(sessions, 'denied');
    await fs.mkdir(denied);
    const saved = path.join(denied, 'session.v4.jsonl.zstd');
    files[saved] = { size: 1, mtimeMs: 0, offset: 0 };
    await fs.chmod(denied, 0);
    try {
      assert.match((await scanDsh(home, files, undefined, read)).problems.join('\n'), /EACCES/);
      assert.ok(files[saved], 'denied directories retain cursors');
    } finally { await fs.chmod(denied, 0o700); }
  }

  const outside = await temporaryDirectory('dsh-outside-');
  await fs.writeFile(path.join(outside, 'session.v4.jsonl.zstd'), 'outside');
  const blocked = path.join(sessions, 'blocked');
  await fs.symlink(outside, blocked);
  const oldFile = path.join(blocked, 'session.v4.jsonl.zstd');
  const prior = { size: 1, offset: 0, mtimeMs: 1, session: 'old' };
  files[oldFile] = prior;
  await fs.symlink(sessions, path.join(sessions, 'loop'));
  await fs.symlink(path.join(home, 'gone'), path.join(sessions, 'broken'));
  const bad = await scanDsh(home, files, undefined, read);
  assert.match(bad.problems.join('\n'), /outside.*sessions|escapes.*root/i);
  assert.match(bad.problems.join('\n'), /loop/i);
  assert.match(bad.problems.join('\n'), /broken/);
  assert.equal(files[oldFile], prior, 'unreadable subtrees retain their cursors');
  assert.equal(reads, 1);

  // A dangling future-generation link must not make v4 look authoritative.
  await fs.symlink(path.join(home, 'missing-v5'), path.join(dir, 'session.v5.jsonl.zstd'));
  const future = await scanDsh(home, {}, undefined, read);
  assert.match(future.problems.join('\n'), /session.v5/);
  assert.equal(future.records.length, 0);
  assert.equal(reads, 1, 'never fall back from an unreadable higher generation');
  await scanDsh(home, files, undefined, read);
  assert.ok(files[file], 'an unreadable higher generation does not discard a live v4 cursor');
  await fs.rm(path.join(dir, 'session.v5.jsonl.zstd'));
  await fs.writeFile(path.join(dir, 'session.v5.jsonl.zstd'), 'future');
  assert.match((await scanDsh(home, files, undefined, read)).problems.join('\n'), /Unsupported highest/);
  assert.ok(files[file], 'an unsupported higher generation preserves the v4 cursor');

  const cliHome = await temporaryDirectory('dsh-links-cli-');
  await fs.mkdir(path.join(cliHome, 'sessions'));
  await fs.symlink(outside, path.join(cliHome, 'sessions', 'blocked'));
  const shared = path.join(cliHome, 'store');
  const run = spawnSync(process.execPath, [path.resolve(__dirname, '../src/cli.js'), 'flush', '--source', 'dsh', '--dsh-home', cliHome], {
    env: { ...process.env, AGY_TOKEN_TRACKER_HOME: shared }, encoding: 'utf8',
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /DSH: Incomplete/);
  const stored = JSON.parse(await fs.readFile(path.join(shared, 'usage-v3.json'), 'utf8'));
  assert.equal(stored.sourceHealth.dsh.status, 'incomplete');
  assert.equal(Object.keys(stored.records).length, 0);
});
