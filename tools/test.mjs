#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, promises as fs, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnvironment } from './hermetic.mjs';

/**
 * Runs the compiled tests (out/test/*.test.js, or the files named) in a hermetic environment: a temporary HOME, no variables that
 * select real data folders, and the network guard preloaded. `npm test` compiles first; this file never compiles.
 *
 *   --max-skipped N   fail when more than N tests were skipped
 *   other -options    passed to `node --test`; other arguments are test files
 */
const project = fileURLToPath(new URL('../', import.meta.url));
const guard = path.join(project, 'tools', 'net-guard.cjs');
const SKIPPED = /^(?:ℹ|#)\s+skipped\s+(\d+)\s*$/gm;
const ANSI_COLOR = /\u001b\[[0-9;]*m/g;

function parseArguments(argv) {
  const nodeOptions = [], files = [];
  let maxSkipped;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--max-skipped') {
      const value = inline ?? argv[++i];
      if (!/^\d+$/.test(value ?? '')) throw new Error(`--max-skipped needs a whole number, not ${JSON.stringify(value)}`);
      maxSkipped = Number(value);
    } else if (argv[i].startsWith('-')) nodeOptions.push(argv[i]);
    else files.push(argv[i]);
  }
  return { nodeOptions, files, maxSkipped };
}

/** Compiled tests whose source was deleted keep running from an old out/ folder: refuse them. */
function staleTests() {
  const compiled = path.join(project, 'out', 'test');
  if (!existsSync(compiled)) throw new Error('out/test does not exist; compile first (npm test does)');
  const sources = path.join(project, 'test');
  return readdirSync(compiled)
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => ({ name, source: path.join(sources, name.replace(/\.js$/, '.ts')) }))
    .filter(({ source }) => !existsSync(source))
    .map(({ name }) => name);
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(2);
}

let files = options.files;
if (!files.length) {
  try {
    const stale = staleTests();
    if (stale.length) throw new Error(`out/test holds compiled tests without a source in test/: ${stale.join(', ')}. Run npm run clean, then compile again.`);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  files = readdirSync(path.join(project, 'out', 'test')).filter((name) => name.endsWith('.test.js')).map((name) => path.join(project, 'out', 'test', name));
}

const { name } = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-tests-`));
const home = path.join(temporary, 'home');
await fs.mkdir(home);
const env = hermeticEnvironment(process.env, { home, temporary, guard });
const counting = options.maxSkipped !== undefined;
let child;
const stop = (signal) => child?.kill(signal);
const interrupt = () => stop('SIGINT');
const terminate = () => stop('SIGTERM');

try {
  child = spawn(process.execPath, ['--test', '--require', guard, ...options.nodeOptions, ...files], {
    cwd: project,
    env,
    stdio: ['inherit', counting ? 'pipe' : 'inherit', 'inherit'],
  });
  let tail = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
    tail = (tail + chunk).slice(-16384);
  });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => resolve(status ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  process.exitCode = code;
  if (counting && code === 0) {
    const counts = [...tail.replace(ANSI_COLOR, '').matchAll(SKIPPED)];
    if (!counts.length) {
      console.error('error: the test output has no skipped count, so --max-skipped cannot be checked');
      process.exitCode = 1;
    } else if (Number(counts.at(-1)[1]) > options.maxSkipped) {
      console.error(`error: ${counts.at(-1)[1]} tests were skipped, at most ${options.maxSkipped} are allowed`);
      process.exitCode = 1;
    }
  }
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
}
