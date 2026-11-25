import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { bundleVersion, installCli } from '../src/cliInstall';

const bundle = (version: string | undefined, body = 'run();'): string => `${version ? `// ai-usage-monitor ${version}\n` : ''}${body}\n`;

async function setup(bundled: string, installed?: string): Promise<{ from: string; to: string }> {
  const dir = await temporaryDirectory('ai-usage-cli-');
  const from = path.join(dir, 'bundled.js');
  const to = path.join(dir, 'shared', 'cli.js');
  await fs.writeFile(from, bundled);
  if (installed !== undefined) {
    await fs.mkdir(path.dirname(to));
    await fs.writeFile(to, installed);
  }
  return { from, to };
}

test('the version is read from the first line of a built bundle', () => {
  assert.deepEqual(bundleVersion('// ai-usage-monitor 1.10.2\nx'), [1, 10, 2]);
  assert.equal(bundleVersion('"use strict";\n// ai-usage-monitor 1.1.0'), undefined);
  assert.equal(bundleVersion('run();'), undefined);
});

test('the CLI is installed even when the shared folder does not exist yet', async () => {
  const { from, to } = await setup(bundle('1.1.0'));
  assert.equal(await installCli(from, to), 'installed');
  assert.equal(await fs.readFile(to, 'utf8'), bundle('1.1.0'));
  assert.deepEqual((await fs.readdir(path.dirname(to))).sort(), ['cli.js']);
});

test('an older or unstamped copy is replaced, an identical one is left alone', async () => {
  for (const old of [bundle('1.0.0'), bundle(undefined, 'old();'), bundle('1.1.0', 'other();')]) {
    const { from, to } = await setup(bundle('1.1.0'), old);
    assert.equal(await installCli(from, to), 'installed');
    assert.equal(await fs.readFile(to, 'utf8'), bundle('1.1.0'));
  }
  const same = await setup(bundle('1.1.0'), bundle('1.1.0'));
  assert.equal(await installCli(same.from, same.to), 'current');
});

test('a newer copy is kept, so an editor running an older extension cannot downgrade the CLI', async () => {
  // 1.9.0 is older than 1.10.0 although it sorts after it as text
  for (const [mine, theirs] of [['1.0.0', '1.1.0'], ['1.9.0', '1.10.0'], ['1.1.0', '2.0.0']]) {
    const { from, to } = await setup(bundle(mine), bundle(theirs));
    assert.equal(await installCli(from, to), 'kept newer');
    assert.equal(await fs.readFile(to, 'utf8'), bundle(theirs));
  }
});

test('CLI installation repairs its missing worker and older bundles cannot replace a newer worker', async () => {
  const { from, to } = await setup(bundle('1.1.0'), bundle('1.1.0'));
  const worker = path.join(path.dirname(from), 'dshWorker.js');
  const target = path.join(path.dirname(to), 'dshWorker-1.1.0.js');
  const nextWorker = path.join(path.dirname(to), 'dshWorker-1.2.0.js');
  await fs.writeFile(worker, bundle('1.1.0', 'worker();'));
  assert.equal(await installCli(from, to), 'current');
  assert.equal(await fs.readFile(target, 'utf8'), bundle('1.1.0', 'worker();'));
  await fs.writeFile(to, bundle('1.2.0'));
  await fs.writeFile(nextWorker, bundle('1.2.0', 'newWorker();'));
  assert.equal(await installCli(from, to), 'kept newer');
  assert.equal(await fs.readFile(nextWorker, 'utf8'), bundle('1.2.0', 'newWorker();'));
});

test('workers of earlier versions are removed once the CLI is current, and later or unstamped ones are left', async () => {
  const names = ['dshWorker-1.2.0.js', 'dshWorker-1.3.0.js', 'dshWorker-1.9.0.js', 'dshWorker-1.10.0.js', 'dshWorker-1.11.0.js', 'dshWorker-x.js', 'dshWorker.js', 'dshWorker-1.3.0.js.map', 'cli.js.bak'];
  const seed = async (to: string) => { for (const name of names) await fs.writeFile(path.join(path.dirname(to), name), 'x'); };
  const left = async (to: string) => (await fs.readdir(path.dirname(to))).sort();

  const installed = await setup(bundle('1.10.0'), bundle('1.9.0'));
  await seed(installed.to);
  await fs.writeFile(path.join(path.dirname(installed.from), 'dshWorker.js'), bundle('1.10.0', 'worker();'));
  assert.equal(await installCli(installed.from, installed.to), 'installed');
  assert.deepEqual(await left(installed.to), ['cli.js', 'cli.js.bak', 'dshWorker-1.10.0.js', 'dshWorker-1.11.0.js', 'dshWorker-1.3.0.js.map', 'dshWorker-x.js', 'dshWorker.js']);

  const current = await setup(bundle('1.10.0'), bundle('1.10.0'));
  await seed(current.to);
  assert.equal(await installCli(current.from, current.to), 'current');
  assert.deepEqual(await left(current.to), ['cli.js', 'cli.js.bak', 'dshWorker-1.10.0.js', 'dshWorker-1.11.0.js', 'dshWorker-1.3.0.js.map', 'dshWorker-x.js', 'dshWorker.js']);

  const newer = await setup(bundle('1.9.0'), bundle('1.10.0'));
  await seed(newer.to);
  assert.equal(await installCli(newer.from, newer.to), 'kept newer');
  assert.deepEqual(await left(newer.to), ['cli.js', 'cli.js.bak', 'dshWorker-1.10.0.js', 'dshWorker-1.11.0.js', 'dshWorker-1.3.0.js.map', 'dshWorker-x.js', 'dshWorker.js'], 'the installed CLI decides, not the bundle that was refused');

  const unstamped = await setup(bundle(undefined, 'old();'), bundle(undefined, 'older();'));
  await seed(unstamped.to);
  assert.equal(await installCli(unstamped.from, unstamped.to), 'installed');
  assert.equal((await left(unstamped.to)).filter(name => /^dshWorker-\d.*\.js$/.test(name)).length, 5, 'with no version to compare, nothing is removed');
});
