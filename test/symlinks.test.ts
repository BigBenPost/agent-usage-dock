import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { listAntigravityTranscripts } from '../src/collectors/antigravity';
import { discoverDsh } from '../src/collectors/dsh';
import { listJsonl } from '../src/collectors/lines';
import { refreshUsage } from '../src/scan';
import { findSessionLog } from '../src/sessionInfo';
import { UsageStore } from '../src/store';
import { temporaryDirectory } from './temp';

const skip = process.platform === 'win32' ? 'symlinks need privileges on Windows' : false;
const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const claudeLine = (id: string) => JSON.stringify({ type: 'assistant', sessionId: 's-' + id, timestamp: '2026-11-20T10:00:00Z', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n';

async function tree(files: Record<string, string>): Promise<string> {
  const root = await temporaryDirectory('symlinks-');
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  return root;
}

test('symlinked project folders and symlinked files are read, with status ok', { skip }, async () => {
  const root = await temporaryDirectory('symlinks-claude-');
  const claudeHome = path.join(root, 'claude');
  const real = path.join(root, 'elsewhere');
  await fs.mkdir(path.join(claudeHome, 'projects', 'projB'), { recursive: true });
  await fs.mkdir(path.join(claudeHome, 'projects', 'projC'), { recursive: true });
  await fs.mkdir(path.join(real, 'projA'), { recursive: true });
  await fs.mkdir(path.join(real, 'projB'), { recursive: true });
  await fs.writeFile(path.join(real, 'projA', 'a.jsonl'), claudeLine('msg_dirlink'));
  await fs.writeFile(path.join(real, 'projB', 'b.jsonl'), claudeLine('msg_filelink'));
  await fs.writeFile(path.join(claudeHome, 'projects', 'projC', 'c.jsonl'), claudeLine('msg_regular'));
  await fs.symlink(path.join(real, 'projA'), path.join(claudeHome, 'projects', 'projA'));
  await fs.symlink(path.join(real, 'projB', 'b.jsonl'), path.join(claudeHome, 'projects', 'projB', 'b.jsonl'));

  const file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const result = await refreshUsage(store, file, path.join(root, 'agy'), false, { source: 'claude', claudeHome });
  assert.deepEqual(Object.keys(store.data.records).sort(), ['claude:msg_dirlink', 'claude:msg_filelink', 'claude:msg_regular']);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.sources, [{ source: 'claude', status: 'ok' }]);
  assert.ok(store.data.files[path.join(claudeHome, 'projects', 'projA', 'a.jsonl')]);
});

test('a link to nowhere counts as vanished and is not a problem', { skip }, async () => {
  const root = await tree({ 'a/x.jsonl': '{}\n' });
  await fs.symlink(path.join(root, 'gone'), path.join(root, 'a', 'dangling.jsonl'));
  await fs.symlink(path.join(root, 'gone-dir'), path.join(root, 'dangling-dir'));
  const problems: string[] = [];
  assert.deepEqual(await listJsonl(root, problems), [path.join(root, 'a', 'x.jsonl')]);
  assert.deepEqual(problems, []);
});

test('a symlink loop ends and is reported, and a folder reachable twice is listed once', { skip }, async () => {
  const root = await tree({ 'a/x.jsonl': '{}\n', 'b/y.jsonl': '{}\n' });
  await fs.symlink(root, path.join(root, 'a', 'up'));
  await fs.symlink(path.join(root, 'b'), path.join(root, 'also-b'));
  await fs.symlink(path.join(root, 'a', 'x.jsonl'), path.join(root, 'b', 'copy.jsonl'));
  const problems: string[] = [];
  const found = await listJsonl(root, problems);
  assert.deepEqual(found, [path.join(root, 'a', 'x.jsonl'), path.join(root, 'b', 'y.jsonl')]);
  assert.deepEqual(problems, [`symlink loop at ${path.join(root, 'a', 'up')}`]);
});

test('links that cannot be followed are problems', { skip }, async () => {
  const root = await tree({ 'a/x.jsonl': '{}\n' });
  await fs.symlink(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  await fs.symlink(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  const problems: string[] = [];
  assert.deepEqual(await listJsonl(root, problems), [path.join(root, 'a', 'x.jsonl')]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^cannot follow .*loop-a: ELOOP$/);
});

test('a folder refused by permissions is a problem and keeps the states of its files', { skip: skip || asRoot }, async () => {
  const root = await tree({ 'open/x.jsonl': '{}\n', 'closed/y.jsonl': '{}\n' });
  await fs.chmod(path.join(root, 'closed'), 0o000);
  try {
    const problems: string[] = [];
    assert.deepEqual(await listJsonl(root, problems), [path.join(root, 'open', 'x.jsonl')]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^cannot list .*closed: (EACCES|EPERM)$/);
  } finally {
    await fs.chmod(path.join(root, 'closed'), 0o700);
  }
});

test('Antigravity conversation folders may be symlinks; broken and looping links are handled', { skip }, async () => {
  const root = await temporaryDirectory('symlinks-agy-');
  const brain = path.join(root, 'brain');
  const logs = (base: string) => path.join(base, '.system_generated', 'logs');
  await fs.mkdir(logs(path.join(root, 'moved', 'conv-link')), { recursive: true });
  await fs.writeFile(path.join(logs(path.join(root, 'moved', 'conv-link')), 'transcript.jsonl'), '{}\n');
  await fs.mkdir(logs(path.join(brain, 'conv-real')), { recursive: true });
  await fs.writeFile(path.join(logs(path.join(brain, 'conv-real')), 'transcript.jsonl'), '{}\n');
  await fs.symlink(path.join(root, 'moved', 'conv-link'), path.join(brain, 'conv-link'));
  await fs.symlink(path.join(brain, 'conv-real'), path.join(brain, 'conv-alias'));
  await fs.symlink(path.join(root, 'nowhere'), path.join(brain, 'conv-dangling'));
  await fs.symlink(path.join(brain, 'conv-loop'), path.join(brain, 'conv-loop'));
  const problems: string[] = [];
  const found = await listAntigravityTranscripts(brain, problems);
  assert.deepEqual(found.map(file => path.basename(path.dirname(path.dirname(path.dirname(file))))), ['conv-real', 'conv-link']);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /conv-loop.*ELOOP$/);
});

test('findSessionLog finds logs under symlinked folders', { skip }, async () => {
  const root = await temporaryDirectory('symlinks-find-');
  const claudeHome = path.join(root, 'claude');
  await fs.mkdir(path.join(claudeHome, 'projects'), { recursive: true });
  await fs.mkdir(path.join(root, 'elsewhere'));
  await fs.writeFile(path.join(root, 'elsewhere', 'session-1.jsonl'), claudeLine('msg_1'));
  await fs.symlink(path.join(root, 'elsewhere'), path.join(claudeHome, 'projects', 'linked'));
  assert.equal(await findSessionLog('claude', 'session-1', '', { claudeHome }), path.join(claudeHome, 'projects', 'linked', 'session-1.jsonl'));
});

test('DSH discovery keeps its containment rules and does not follow symlinks', { skip }, async () => {
  const root = await temporaryDirectory('symlinks-dsh-');
  const home = path.join(root, 'dsh');
  const outside = path.join(root, 'outside', 'session-x');
  await fs.mkdir(path.join(home, 'sessions', 'w', 'inside'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(home, 'sessions', 'w', 'inside', 'session.v4.jsonl.zstd'), 'x');
  await fs.writeFile(path.join(outside, 'session.v4.jsonl.zstd'), 'x');
  await fs.symlink(outside, path.join(home, 'sessions', 'w', 'linked-dir'));
  await fs.mkdir(path.join(home, 'sessions', 'w', 'linked-file'));
  await fs.symlink(path.join(outside, 'session.v4.jsonl.zstd'), path.join(home, 'sessions', 'w', 'linked-file', 'session.v4.jsonl.zstd'));
  assert.deepEqual(await discoverDsh(home), [path.join(home, 'sessions', 'w', 'inside', 'session.v4.jsonl.zstd')]);
});
