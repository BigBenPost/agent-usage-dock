import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { currentArchiveFile } from '../src/backup';

const cli = path.join(__dirname, '..', 'src', 'cli.js');
const asRoot = process.getuid?.() === 0;

/** Both names of the shared folder are set, and every home variable is cleared, so nothing on the machine running the tests leaks in. */
const cliEnv = (home: string, shared = path.join(home, 'shared')) => ({
  ...process.env, HOME: home, USERPROFILE: home, AGY_TOKEN_TRACKER_HOME: shared, AGY_TOKEN_MONITOR_HOME: shared,
  ANTIGRAVITY_HOME: '', DSH_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '',
});
const run = (home: string, ...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env: cliEnv(home), encoding: 'utf8' });

/** A home folder with one Antigravity transcript, and the CLI run against it. */
async function flush(prepare?: (home: string, log: string) => Promise<void>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const home = await temporaryDirectory('agy-cli-home-');
  const dir = path.join(home, '.gemini', 'antigravity', 'brain', 'conv-1', '.system_generated', 'logs');
  await fs.mkdir(dir, { recursive: true });
  const log = path.join(dir, 'transcript.jsonl');
  const line = { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: new Date().toISOString(), input_tokens: 5, output_tokens: 7 };
  await fs.writeFile(log, `${JSON.stringify(line)}\n`);
  await prepare?.(home, log);
  return run(home, 'flush');
}

test('flush reads the logs into the store and exits 0', async () => {
  const run = await flush();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /1 records added or updated from 1 changed files/);
});

test('flush exits 1 when a log cannot be read', { skip: asRoot || process.platform === 'win32' }, async () => {
  const run = await flush((_home, log) => fs.chmod(log, 0o000));
  assert.equal(run.status, 1);
  assert.match(run.stderr, /transcript\.jsonl/);
});

test('flush exits 1 on a store that is not valid', async () => {
  const broken = await flush(async (home) => {
    await fs.mkdir(path.join(home, 'shared'));
    await fs.writeFile(path.join(home, 'shared', 'usage.json'), '{"days":[]}');
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /ERROR: .*"days" is missing or malformed/);
});

test('import merges another store into the shared store and exits 0', async () => {
  const home = await temporaryDirectory('agy-cli-import-');
  const shared = path.join(home, 'shared');
  await fs.mkdir(shared, { recursive: true });
  const otherFile = path.join(home, 'import-source.json');
  const otherData = {
    version: 2,
    records: {
      'antigravity:ext:1': {
        id: 'antigravity:ext:1',
        source: 'antigravity',
        model: 'gemini-1.5-flash',
        day: '2026-10-20',
        tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 },
        session: 'ext',
      },
    },
    days: {},
    seen: {},
    open: {},
    files: {},
  };
  await fs.writeFile(otherFile, JSON.stringify(otherData));
  const res = run(home, 'import', otherFile);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Imported .* 1 new records added/);

  // verify the archive ledger was also saved
  const archivePath = path.join(shared, 'archive', 'history-ledger-v3.json');
  const archiveData = JSON.parse(await fs.readFile(archivePath, 'utf8'));
  assert.equal(Object.keys(archiveData.records || {}).length, 1);
});

test('import exits 1 for non-existent file and 2 for invalid arguments', async () => {
  const home = await temporaryDirectory('agy-cli-import-err-');
  const noArg = run(home, 'import');
  assert.equal(noArg.status, 2);
  const tooManyArgs = run(home, 'import', 'a', 'b');
  assert.equal(tooManyArgs.status, 2);
  const missing = run(home, 'import', path.join(home, 'missing.json'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ERROR: file not found/);
});

const USAGE_TITLE = /^agent-usage-dock CLI\n  node cli\.js flush /;

test('--help, -h and help print the usage to stdout and exit 0', async () => {
  const home = await temporaryDirectory('agy-cli-help-');
  for (const word of ['--help', '-h', 'help']) {
    const res = run(home, word);
    assert.equal(res.status, 0, word);
    assert.match(res.stdout, USAGE_TITLE, word);
    assert.match(res.stdout, /node cli\.js import <file>/, word);
    assert.equal(res.stderr, '', word);
  }
  await assert.rejects(fs.stat(path.join(home, 'shared')), 'help never creates the store folder');
});

test('no command, an unknown command, and a command with stray words print the usage to stderr and exit 2', async () => {
  const home = await temporaryDirectory('agy-cli-usage-');
  for (const args of [[], ['nope'], ['--version'], ['FLUSH'], ['import-file'], ['-help']]) {
    const res = run(home, ...args);
    assert.equal(res.status, 2, JSON.stringify(args));
    assert.match(res.stderr, USAGE_TITLE, JSON.stringify(args));
    assert.equal(res.stdout, '', JSON.stringify(args));
  }
  await assert.rejects(fs.stat(path.join(home, 'shared')), 'a bad command never creates the store folder');
});

test('every malformed flush argument list is refused with the usage and exit 2, before anything is read', async () => {
  const home = await temporaryDirectory('agy-cli-flags-');
  const bad: string[][] = [
    ['--source'], ['--source', 'nope'], ['--source', 'ALL'], ['--home'], ['--dsh-home'], ['--claude-home'], ['--codex-home'],
    ['--home', '--source'], ['--source', 'claude', '--source', 'codex'], ['--home', 'a', '--home', 'b'],
    ['--bogus', 'x'], ['extra'], ['--source', 'claude', 'extra'], ['--source', 'claude', '--codex-home'], ['--help'], ['-h'],
  ];
  for (const flags of bad) {
    const res = run(home, 'flush', ...flags);
    assert.equal(res.status, 2, flags.join(' '));
    assert.match(res.stderr, USAGE_TITLE, flags.join(' '));
    assert.equal(res.stdout, '', flags.join(' '));
  }
  await assert.rejects(fs.stat(path.join(home, 'shared')), 'a refused command never creates the store folder');
});

test('each home flag points its source at the given folder, and --source all reports every source', async () => {
  const home = await temporaryDirectory('agy-cli-homes-');
  const [agy, dsh, claude, codex] = ['agy', 'dsh', 'claude', 'codex'].map(name => path.join(home, name));
  await Promise.all([agy, dsh, claude, codex].map(dir => fs.mkdir(dir)));
  await fs.mkdir(path.join(claude, 'projects'));
  const line = { type: 'assistant', sessionId: 'cli-claude', timestamp: '2026-11-20T10:00:00Z', message: { id: 'msg_cli', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 7 } } };
  await fs.writeFile(path.join(claude, 'projects', 'a.jsonl'), JSON.stringify(line) + '\n');
  const res = run(home, 'flush', '--source', 'all', '--home', agy, '--dsh-home', dsh, '--claude-home', claude, '--codex-home', codex);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1 records added or updated from 1 changed files/);
  assert.deepEqual(res.stdout.split('\n').filter(l => /: (Ready|Incomplete|Not installed|Disabled)$/.test(l)), ['Antigravity: Ready', 'DSH: Ready', 'Claude Code: Ready', 'Codex: Ready']);
  const single = run(home, 'flush', '--source', 'claude', '--claude-home', claude);
  assert.equal(single.status, 0, single.stderr);
  assert.match(single.stdout, /Claude Code: Ready/);
  assert.doesNotMatch(single.stdout, /Codex/);
  assert.match(run(home, 'flush', '--source', 'codex', '--codex-home', codex).stdout, /Codex: Ready/);
  assert.match(run(home, 'flush', '--source', 'dsh', '--dsh-home', dsh).stdout, /DSH: Ready/);
});

test('a source folder that was named but is missing fails the flush, while unnamed absent sources only read as not found', async () => {
  const home = await temporaryDirectory('agy-cli-missing-');
  const named = run(home, 'flush', '--source', 'all', '--dsh-home', path.join(home, 'nowhere'));
  assert.equal(named.status, 1);
  assert.match(named.stdout, /DSH: Incomplete/);
  assert.match(named.stderr, /ERROR: DSH data directory unavailable/);
  assert.match(named.stderr, /some logs could not be read/);
  const absent = run(home, 'flush', '--source', 'all');
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /Codex: Not installed/);
});

test('a damaged archive stops the CLI with an error that names it and points to the README, and leaves it alone', async () => {
  const home = await temporaryDirectory('agy-cli-archive-');
  const shared = path.join(home, 'shared');
  await fs.mkdir(path.join(shared, 'archive'), { recursive: true });
  await fs.writeFile(path.join(shared, 'usage-v3.json'), JSON.stringify({ version: 3, records: {}, days: {} }));
  const archive = currentArchiveFile(path.join(shared, 'usage-v3.json'));
  await fs.writeFile(archive, '{truncated');
  const res = run(home, 'flush');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ERROR: .*history-ledger-v3\.json.*README/);
  assert.equal(await fs.readFile(archive, 'utf8'), '{truncated');
});

test('the CLI ends through the exit code, with all of its output delivered through a pipe', async () => {
  const home = await temporaryDirectory('agy-cli-pipe-');
  const res = spawnSync(process.execPath, [cli, 'help'], { env: cliEnv(home), encoding: 'utf8', maxBuffer: 1 << 20, timeout: 20_000 });
  assert.equal(res.status, 0);
  assert.ok(res.stdout.trimEnd().endsWith('print this text'));
});
