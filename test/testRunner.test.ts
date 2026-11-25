import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from './temp';

const project = path.resolve(__dirname, '../..');
const TOOL_FILES = ['test.mjs', 'hermetic.mjs', 'net-guard.cjs', 'clean.mjs'];

/** A project folder with the runner and its helpers copied in, so the runner works on fixtures instead of this project. */
async function fakeProject(): Promise<string> {
  const root = await temporaryDirectory('runner-project-');
  await fs.mkdir(path.join(root, 'tools'));
  for (const file of TOOL_FILES) await fs.copyFile(path.join(project, 'tools', file), path.join(root, 'tools', file));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-project', version: '0.0.0' }));
  return root;
}

function environment(parent: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent, USAGE_MONITOR_TEST_TMP_ROOT: parent, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.error, undefined);
  return result;
}

const SENTINELS = {
  HOME: '/sentinel/home',
  USERPROFILE: '/sentinel/home',
  AGY_TOKEN_TRACKER_HOME: '/sentinel/tracker',
  AGY_TOKEN_MONITOR_HOME: '/sentinel/monitor',
  AGY_SQLITE3: '/sentinel/sqlite3',
  AGY_ANYTHING_ELSE: 'x',
  ANTIGRAVITY_HOME: '/sentinel/antigravity',
  DSH_HOME: '/sentinel/dsh',
  CLAUDE_CONFIG_DIR: '/sentinel/claude',
  CODEX_HOME: '/sentinel/codex',
  AGY_TEST_REQUIRE_SQLITE: '1',
  NODE_OPTIONS: '--no-warnings',
};

test('the runner gives the tests a temporary home, no data-folder variables and a network guard, in every process they start', async () => {
  const root = await temporaryDirectory('runner-hermetic-');
  const parent = path.join(root, 'temporary');
  await fs.mkdir(parent);
  const report = path.join(root, 'report.json');
  const fixture = path.join(root, 'fixture.cjs');
  await fs.writeFile(fixture, `
const fs = require('node:fs'), os = require('node:os'), net = require('node:net');
const { spawnSync } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');
const blocked = "try { require('node:net').connect(80, 'example.com'); } catch (error) { console.log(error.code); process.exitCode = 0; }";
test('report', async () => {
  const names = ${JSON.stringify(Object.keys(SENTINELS))};
  const exitCode = process.exitCode;
  let direct;
  try { net.connect(80, 'example.com'); } catch (error) { direct = error.code; }
  process.exitCode = exitCode;
  const child = spawnSync(process.execPath, ['-e', blocked], { encoding: 'utf8' }).stdout.trim();
  const worker = await new Promise((resolve) => {
    const thread = new Worker(\`const { parentPort } = require('node:worker_threads'); let code; try { require('node:net').connect(80, 'example.com'); } catch (error) { code = error.code; } parentPort.postMessage(code);\`, { eval: true });
    thread.once('message', resolve);
    thread.once('error', (error) => resolve(String(error)));
  });
  fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
    variables: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null])),
    homedir: os.homedir(), tmpdir: os.tmpdir(), direct, child, worker,
  }));
});
`);

  const result = run(path.join(project, 'tools', 'test.mjs'), [fixture], environment(parent, SENTINELS), project);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = JSON.parse(await fs.readFile(report, 'utf8'));
  const { variables } = seen;
  assert.equal(variables.HOME, path.join(seen.tmpdir, 'home'));
  assert.equal(variables.USERPROFILE, variables.HOME);
  assert.equal(seen.homedir, variables.HOME);
  for (const name of ['AGY_TOKEN_TRACKER_HOME', 'AGY_TOKEN_MONITOR_HOME', 'AGY_SQLITE3', 'AGY_ANYTHING_ELSE', 'ANTIGRAVITY_HOME', 'DSH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
    assert.equal(variables[name], null, `${name} must not reach the tests`);
  }
  assert.equal(variables.AGY_TEST_REQUIRE_SQLITE, '1', 'AGY_TEST_* switches pass through');
  assert.match(variables.NODE_OPTIONS, /^--no-warnings --require ".*net-guard\.cjs"$/);
  assert.deepEqual({ direct: seen.direct, child: seen.child, worker: seen.worker }, { direct: 'ERR_NET_GUARD', child: 'ERR_NET_GUARD', worker: 'ERR_NET_GUARD' });
  assert.deepEqual(await fs.readdir(parent), [], 'the temporary home is removed with the run');
});

async function listing(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    out.push(entry.isDirectory() ? `${entry.name}/` : `${entry.name} ${(await fs.stat(file)).size}`);
    if (entry.isDirectory()) out.push(...(await listing(file)).map((name) => `${entry.name}/${name}`));
  }
  return out.sort();
}

test('a data folder or home exported by the caller is never read or written by tests that run the CLI', async () => {
  const root = await temporaryDirectory('runner-leak-');
  const realHome = path.join(root, 'real-home');
  const realLedger = path.join(root, 'real-ledger');
  await fs.mkdir(path.join(realHome, '.agy-token-monitor'), { recursive: true });
  await fs.writeFile(path.join(realHome, '.agy-token-monitor', 'usage-v2.json'), '{"version":2,"records":"not a store"}');
  await fs.mkdir(realLedger);
  const before = [...await listing(realHome), ...await listing(realLedger)];
  const parent = path.join(root, 'temporary');
  await fs.mkdir(parent);
  const exported = { HOME: realHome, USERPROFILE: realHome, AGY_TOKEN_TRACKER_HOME: realLedger, AGY_TOKEN_MONITOR_HOME: realLedger, ANTIGRAVITY_HOME: realHome, CODEX_HOME: realHome, CLAUDE_CONFIG_DIR: realHome };
  const files = ['cli.test.js', 'localAgents.test.js'].map((name) => path.join(project, 'out', 'test', name));
  const result = run(path.join(project, 'tools', 'test.mjs'), files, environment(parent, exported), project);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual([...await listing(realHome), ...await listing(realLedger)], before);
});

const SKIPS = `
const { test } = require('node:test');
test('runs', () => {});
test('skipped without a reason', { skip: true }, () => {});
test('skipped with a reason', { skip: 'not here' }, () => {});
`;

test('--max-skipped fails a run that skipped more tests than allowed, and rejects a value that is not a number', async () => {
  const root = await temporaryDirectory('runner-skips-');
  const fixture = path.join(root, 'skips.cjs');
  await fs.writeFile(fixture, SKIPS);
  const runner = path.join(project, 'tools', 'test.mjs');
  const env = environment(root);

  const allowed = run(runner, ['--max-skipped', '2', fixture], env, project);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /skipped 2/, 'the test output is still shown');

  const exceeded = run(runner, ['--max-skipped=1', fixture], env, project);
  assert.equal(exceeded.status, 1);
  assert.match(exceeded.stderr, /2 tests were skipped, at most 1 are allowed/);

  const none = run(runner, ['--max-skipped', '0', fixture], env, project);
  assert.equal(none.status, 1);

  const unlimited = run(runner, [fixture], env, project);
  assert.equal(unlimited.status, 0);

  // Node 22 and newer colour the spec reporter when FORCE_COLOR is set; the count must still be read.
  const colored = run(runner, ['--test-reporter=spec', '--max-skipped', '2', fixture], { ...env, FORCE_COLOR: '1' }, project);
  assert.equal(colored.status, 0, colored.stdout + colored.stderr);
  const coloredExceeded = run(runner, ['--test-reporter=spec', '--max-skipped', '1', fixture], { ...env, FORCE_COLOR: '1' }, project);
  assert.equal(coloredExceeded.status, 1);

  for (const bad of [['--max-skipped'], ['--max-skipped', 'many'], ['--max-skipped=-1']]) {
    const refused = run(runner, [...bad, fixture], env, project);
    assert.equal(refused.status, 2, bad.join(' '));
    assert.match(refused.stderr, /--max-skipped needs a whole number/);
  }
});

test('a failing test still fails the run when --max-skipped is set', async () => {
  const root = await temporaryDirectory('runner-failing-');
  const fixture = path.join(root, 'failing.cjs');
  await fs.writeFile(fixture, "require('node:test').test('fails', () => { throw new Error('intentional'); });");
  const result = run(path.join(project, 'tools', 'test.mjs'), ['--max-skipped', '5', fixture], environment(root), project);
  assert.equal(result.status, 1);
});

test('the runner refuses compiled tests whose source was deleted, and clean removes only build outputs', async () => {
  const root = await fakeProject();
  const parent = await temporaryDirectory('runner-stale-parent-');
  const marker = (name: string) => path.join(root, `ran-${name}`);
  const compiled = (name: string) => `require('node:fs').writeFileSync(${JSON.stringify(marker(name))}, 'ran'); require('node:test').test('${name}', () => {});`;
  await fs.mkdir(path.join(root, 'test'));
  await fs.writeFile(path.join(root, 'test', 'kept.test.ts'), '');
  await fs.mkdir(path.join(root, 'out', 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'out', 'test', 'kept.test.js'), compiled('kept'));
  await fs.writeFile(path.join(root, 'out', 'test', 'deleted.test.js'), compiled('deleted'));
  const runner = path.join(root, 'tools', 'test.mjs');
  const clean = path.join(root, 'tools', 'clean.mjs');
  const env = environment(parent);

  const stale = run(runner, [], env, root);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /compiled tests without a source in test\/: deleted\.test\.js/);
  assert.equal(existsSync(marker('kept')) || existsSync(marker('deleted')), false, 'no test ran');

  await fs.mkdir(path.join(root, 'dist'));
  await fs.mkdir(path.join(root, 'src'));
  assert.equal(run(clean, ['test'], env).status, 2, 'only out and dist are cleanable');
  assert.ok(existsSync(path.join(root, 'test', 'kept.test.ts')));
  assert.equal(run(clean, ['out'], env).status, 0);
  assert.equal(existsSync(path.join(root, 'out')), false);
  assert.ok(existsSync(path.join(root, 'dist')) && existsSync(path.join(root, 'src')));

  const missing = run(runner, [], env, root);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /out\/test does not exist/);

  await fs.mkdir(path.join(root, 'out', 'test'), { recursive: true });
  await fs.writeFile(path.join(root, 'out', 'test', 'kept.test.js'), compiled('kept'));
  const fresh = run(runner, [], env, root);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.ok(existsSync(marker('kept')));
  assert.equal(existsSync(marker('deleted')), false);
  assert.deepEqual(await fs.readdir(parent), []);

  assert.equal(run(clean, [], env).status, 0);
  assert.deepEqual([existsSync(path.join(root, 'out')), existsSync(path.join(root, 'dist')), existsSync(path.join(root, 'src'))], [false, false, true]);
  assert.equal(run(clean, [], env).status, 0, 'cleaning what is already gone is fine');
});
