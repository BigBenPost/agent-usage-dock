#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnvironment } from './hermetic.mjs';

/**
 * Runs a built CLI bundle the way users do, which the tests (they run the tsc output) never do: `node smoke-bundle.mjs [cli.js]`
 * (default dist/cli.js) runs `flush --source all` with an empty temporary HOME. Every source must report Not installed and the exit
 * status must be 0. It also checks the bundle's version stamp and that the build-time constant was substituted.
 */
const project = fileURLToPath(new URL('../', import.meta.url));
const guard = path.join(project, 'tools', 'net-guard.cjs');
const bundle = path.resolve(process.argv[2] ?? path.join(project, 'dist', 'cli.js'));
const SOURCE_LABELS = ['Antigravity', 'DSH', 'Claude Code', 'Codex'];
const problems = [];

const { version } = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
let text = '';
try {
  text = readFileSync(bundle, 'utf8');
} catch (error) {
  console.error(`smoke: cannot read ${bundle}: ${error.message}`);
  process.exit(1);
}
if (!text.startsWith(`// agent-usage-dock ${version}\n`)) problems.push(`the first line of ${bundle} is not the version stamp for ${version}`);
if (text.includes('__DOCK_BUNDLE_VERSION__')) problems.push('the bundle still contains the unreplaced __DOCK_BUNDLE_VERSION__');

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-'));
try {
  const home = path.join(sandbox, 'home');
  mkdirSync(home);
  const run = spawnSync(process.execPath, [bundle, 'flush', '--source', 'all'], {
    cwd: sandbox,
    env: hermeticEnvironment(process.env, { home, temporary: sandbox, guard }),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (run.error) problems.push(`the CLI did not run: ${run.error.message}`);
  else if (run.status !== 0) problems.push(`flush exited with ${run.status}\n${run.stdout}${run.stderr}`);
  for (const label of SOURCE_LABELS) if (!new RegExp(`^${label}: Not installed$`, 'm').test(run.stdout ?? '')) problems.push(`no "${label}: Not installed" line in the output:\n${run.stdout}`);
  if (run.stdout && !run.stdout.includes(path.join(home, '.agy-token-tracker'))) problems.push(`the usage store is not under the sandbox home:\n${run.stdout}`);
  if (!problems.length) console.log(`Bundle smoke test passed: ${path.relative(project, bundle) || bundle}, version ${version}.`);
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

if (problems.length) {
  for (const problem of problems) console.error(`smoke: ${problem}`);
  process.exit(1);
}
