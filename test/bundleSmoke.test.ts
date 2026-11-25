import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { after, before, test } from 'node:test';
import { temporaryDirectory } from './temp';

const project = path.resolve(__dirname, '../..');
const { version } = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
const smoke = path.join(project, 'tools', 'smoke-bundle.mjs');
let shared: string;
let built: string;

function build(outdir: string, ...flags: string[]) {
  const run = spawnSync(process.execPath, [path.join(project, 'esbuild.mjs'), ...flags, '--outdir', outdir], { cwd: project, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.error, undefined);
  return run;
}

// One build serves every test in the file, so it cannot belong to the first test's cleanup.
before(async () => {
  shared = await fs.mkdtemp(path.join(process.env.USAGE_MONITOR_TEST_TMP_ROOT ?? os.tmpdir(), 'bundle-build-'));
  built = path.join(shared, 'dist');
  const run = build(built);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

after(() => fs.rm(shared, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }));

test('the build writes the Node bundles with a version stamp and the offline bundle with no source maps', async () => {
  assert.deepEqual((await fs.readdir(built)).sort(), ['cli.js', 'dshWorker.js', 'extension.js', 'offline.js']);
  for (const name of ['cli.js', 'dshWorker.js', 'extension.js']) {
    const text = await fs.readFile(path.join(built, name), 'utf8');
    assert.ok(text.startsWith(`// agent-usage-dock ${version}\n`), name);
    assert.doesNotMatch(text, /sourceMappingURL|__DOCK_BUNDLE_VERSION__/, name);
  }
  const cli = await fs.readFile(path.join(built, 'cli.js'), 'utf8');
  assert.ok(cli.includes('dshWorker-') && cli.includes(JSON.stringify(version)), 'the versioned worker lookup carries this version');
});

test('--sourcemap writes maps next to the Node bundles and unknown options are refused', async () => {
  const outdir = path.join(await temporaryDirectory('bundle-maps-'), 'dist');
  const projectMap = path.join(project, 'dist', 'cli.js.map');
  const mapBefore = existsSync(projectMap);
  assert.equal(build(outdir, '--sourcemap').status, 0);
  assert.deepEqual((await fs.readdir(outdir)).sort(), ['cli.js', 'cli.js.map', 'dshWorker.js', 'dshWorker.js.map', 'extension.js', 'extension.js.map', 'offline.js']);
  assert.match(await fs.readFile(path.join(outdir, 'cli.js'), 'utf8'), /\/\/# sourceMappingURL=cli\.js\.map/);
  const unknown = spawnSync(process.execPath, [path.join(project, 'esbuild.mjs'), '--minify'], { cwd: project, encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage: node esbuild\.mjs/);
  assert.equal(existsSync(projectMap), mapBefore, 'a build into another folder leaves dist alone');
});

test('the built CLI flushes an empty home: exit 0 and Not installed for every source', () => {
  const run = spawnSync(process.execPath, [smoke, path.join(built, 'cli.js')], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Bundle smoke test passed/);
});

test('the smoke test rejects a bundle that is stamped for another version, keeps the build constant, or reports another status', async () => {
  const dir = await temporaryDirectory('bundle-smoke-bad-');
  const cli = await fs.readFile(path.join(built, 'cli.js'), 'utf8');
  const cases: Record<string, { text: string; expect: RegExp }> = {
    stamp: { text: cli.replace(`// agent-usage-dock ${version}`, '// agent-usage-dock 0.0.1'), expect: /is not the version stamp for/ },
    constant: { text: `${cli}\n// __DOCK_BUNDLE_VERSION__\n`, expect: /unreplaced __DOCK_BUNDLE_VERSION__/ },
    status: {
      text: `// agent-usage-dock ${version}\nconsole.log('Usage store /nowhere: 0 records');\nfor (const name of ['Antigravity', 'DSH', 'Claude Code']) console.log(name + ': Not installed');\nconsole.log('Codex: Ready');\n`,
      expect: /no "Codex: Not installed" line/,
    },
    failure: { text: `// agent-usage-dock ${version}\nconsole.error('ERROR: boom');\nprocess.exit(1);\n`, expect: /flush exited with 1/ },
  };
  for (const [name, { text, expect }] of Object.entries(cases)) {
    const file = path.join(dir, `${name}.js`);
    await fs.writeFile(file, text);
    const run = spawnSync(process.execPath, [smoke, file], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, expect, name);
  }
  const missing = spawnSync(process.execPath, [smoke, path.join(dir, 'absent.js')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read/);
});
