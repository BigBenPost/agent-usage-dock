import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from './temp';

const project = path.resolve(__dirname, '../..');
const runner = path.join(project, 'tools/test.mjs');
const helper = path.join(__dirname, 'temp.js');

function environment(parent: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: parent, TMP: parent, TEMP: parent, USAGE_MONITOR_TEST_TMP_ROOT: parent };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function fixture(withChild: boolean, fails: boolean): Promise<{ file: string; parent: string; marker: string }> {
  const root = await temporaryDirectory('test-temp-lifecycle-');
  const parent = path.join(root, 'temporary');
  await fs.mkdir(parent);
  const file = path.join(root, 'fixture.cjs');
  const marker = path.join(root, 'executed');
  await fs.writeFile(file, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { temporaryDirectory } = require(${JSON.stringify(helper)});
test('owned fixture', async () => {
  fs.writeFileSync(${JSON.stringify(marker)}, 'fixture ran');
  const directory = await temporaryDirectory('owned-fixture-');
  fs.writeFileSync(path.join(directory, 'value'), 'fixture');
  if (${withChild}) {
    const child = spawnSync(process.execPath, ['-e', "const fs=require('node:fs'),os=require('node:os'),path=require('node:path'); const root=fs.mkdtempSync(path.join(os.tmpdir(),'child-fixture-')); fs.writeFileSync(path.join(root,'value'),'fixture');"], { env: process.env });
    assert.equal(child.status, 0);
    assert.ok(fs.readdirSync(os.tmpdir()).some(name => name.startsWith('child-fixture-')));
  }
  if (${fails}) assert.fail('intentional fixture failure');
});
`);
  return { file, parent, marker };
}

for (const fails of [false, true]) {
  const outcome = fails ? 'failure' : 'success';
  test(`temporary-directory hooks remove their fixtures after ${outcome}`, async () => {
    const { file, parent, marker } = await fixture(false, fails);
    const result = spawnSync(process.execPath, ['--test', file], {
      env: environment(parent),
      encoding: 'utf8',
    });
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    assert.equal(await fs.readFile(marker, 'utf8'), 'fixture ran');
    assert.deepEqual(await fs.readdir(parent), []);
  });

  test(`suite runner removes parent and subprocess fixtures after ${outcome}`, async () => {
    const { file, parent, marker } = await fixture(true, fails);
    const result = spawnSync(process.execPath, [runner, file], {
      cwd: project,
      env: environment(parent),
      encoding: 'utf8',
    });
    assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
    assert.equal(await fs.readFile(marker, 'utf8'), 'fixture ran');
    assert.deepEqual(await fs.readdir(parent), []);
  });
}
