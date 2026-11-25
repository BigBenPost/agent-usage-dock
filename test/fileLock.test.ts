import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { acquireFileLock } from '../src/fileLock';
import { sweepOncePerProcess, sweepStale } from '../src/privateFiles';
import { UsageStore } from '../src/store';
import { temporaryDirectory } from './temp';

const SECOND = 1000;
const deadPid = (): number => spawnSync(process.execPath, ['-e', '']).pid;

async function plant(file: string, options: { pid?: number | string; age: number; info?: unknown }): Promise<string> {
  const dir = `${file}.lock`;
  await fs.mkdir(dir);
  if (options.pid !== undefined) await fs.writeFile(path.join(dir, 'owner'), `${options.pid}-${randomUUID()}`);
  if (options.info !== undefined) await fs.writeFile(path.join(dir, 'info'), typeof options.info === 'string' ? options.info : JSON.stringify(options.info));
  const mtime = new Date(Date.now() - options.age);
  await fs.utimes(dir, mtime, mtime);
  return dir;
}

const newFile = async (): Promise<string> => path.join(await temporaryDirectory('file-lock-'), 'usage-v3.json');
const acquired = async (file: string, waitMs = 3000): Promise<boolean> => {
  const lock = await acquireFileLock(file, { waitMs }).catch(() => undefined);
  await lock?.release();
  return !!lock;
};
const waits = (file: string) => assert.rejects(acquireFileLock(file, { waitMs: 500 }), /timed out waiting for/);

test('a lock names its owner as <pid>-<uuid> for older releases, and keeps the host and time apart in info', async () => {
  const file = await newFile();
  const lock = await acquireFileLock(file);
  const dir = `${file}.lock`;
  assert.match(await fs.readFile(path.join(dir, 'owner'), 'utf8'), /^\d+-[0-9a-f-]{36}$/);
  assert.equal(Number((await fs.readFile(path.join(dir, 'owner'), 'utf8')).split('-')[0]), process.pid);
  const info = JSON.parse(await fs.readFile(path.join(dir, 'info'), 'utf8'));
  assert.equal(typeof info.host, 'string');
  assert.ok(Math.abs(Date.parse(info.acquiredAt) - Date.now()) < 5000);
  await lock.release();
  await assert.rejects(fs.stat(dir));
});

test('a lock heard from in the last 15 seconds is waited for, even when its owner process is gone', async () => {
  const file = await newFile();
  await plant(file, { pid: deadPid(), age: 5 * SECOND });
  await waits(file);
});

test('a lock whose dead owner has been silent for over 15 seconds is taken at once', async () => {
  const file = await newFile();
  const dir = await plant(file, { pid: deadPid(), age: 20 * SECOND });
  const started = Date.now();
  assert.equal(await acquired(file), true);
  assert.ok(Date.now() - started < 2000);
  await assert.rejects(fs.stat(dir));
});

test('a fresh lock becomes takeable once its age passes 15 seconds', async () => {
  const file = await newFile();
  const dir = await plant(file, { pid: deadPid(), age: 2 * SECOND });
  const started = Date.now();
  const attempt = acquireFileLock(file, { waitMs: 5000 });
  await new Promise(resolve => setTimeout(resolve, 400));
  const stale = new Date(Date.now() - 20 * SECOND);
  await fs.utimes(dir, stale, stale);
  await (await attempt).release();
  assert.ok(Date.now() - started < 3000);
});

test('a live owner that has gone quiet for minutes is still waited for, until 5 minutes', async () => {
  const file = await newFile();
  await plant(file, { pid: process.pid, age: 2 * 60 * SECOND });
  await waits(file);
});

test('after 5 minutes of silence the lock is taken whoever the recorded process is now', async () => {
  const file = await newFile();
  await plant(file, { pid: process.pid, age: 6 * 60 * SECOND });
  assert.equal(await acquired(file), true);
});

test('a lock one hour old whose process id now belongs to an unrelated live process is taken', async () => {
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
  try {
    const file = await newFile();
    await plant(file, { pid: bystander.pid, age: 60 * 60 * SECOND });
    assert.equal(await acquired(file), true);
  } finally { bystander.kill(); }
});

test('a lock stamped in the future counts by how far off it is', async () => {
  for (const [pid, age, expected] of [[deadPid(), -2 * 3600 * SECOND, true], [process.pid, -2 * 3600 * SECOND, true], [deadPid(), -10 * SECOND, false], [deadPid(), -20 * SECOND, true], [process.pid, -10 * SECOND, false]] as const) {
    const file = await newFile();
    await plant(file, { pid, age });
    if (expected) assert.equal(await acquired(file), true, `${pid} ${age}`);
    else await waits(file);
  }
});

test('the process table of another machine says nothing about a lock left on a shared folder', async () => {
  const file = await newFile();
  await plant(file, { pid: deadPid(), age: 20 * SECOND, info: { host: 'another-machine.example', acquiredAt: new Date().toISOString() } });
  await waits(file);
  const old = await newFile();
  await plant(old, { pid: deadPid(), age: 6 * 60 * SECOND, info: { host: 'another-machine.example' } });
  assert.equal(await acquired(old), true);
});

test('a lock from an older release, with no info, or with an unreadable one, is judged by its owner process', async () => {
  for (const info of [undefined, '{broken', '[]', 'null', { host: 5 }]) {
    const file = await newFile();
    await plant(file, { pid: deadPid(), age: 20 * SECOND, info });
    if (info !== undefined && typeof info === 'object' && !Array.isArray(info)) await waits(file);
    else assert.equal(await acquired(file), true, JSON.stringify(info));
  }
});

test('a lock folder whose owner never got written is taken after 15 seconds', async () => {
  const file = await newFile();
  await plant(file, { age: 20 * SECOND });
  const started = Date.now();
  assert.equal(await acquired(file), true);
  assert.ok(Date.now() - started < 3000);
});

test('a holder whose lock was reclaimed finds out before it writes', async () => {
  const file = await newFile();
  const lock = await acquireFileLock(file);
  await fs.writeFile(path.join(`${file}.lock`, 'owner'), `${deadPid()}-someone-else`);
  await assert.rejects(lock.assertHeld(), /lost the lock/);
  await lock.release();
  assert.ok((await fs.stat(`${file}.lock`)).isDirectory(), 'the new owner\'s lock is left alone');
});

test('several processes starting on an abandoned lock take turns, and nothing is lost', async () => {
  const dir = await temporaryDirectory('file-lock-race-');
  await plant(path.join(dir, 'usage-v3.json'), { pid: deadPid(), age: 5 * 60 * SECOND });
  const worker = path.join(__dirname, 'lockWorker.js');
  const [workers, rounds] = [4, 5];
  const exits = await Promise.all(Array.from({ length: workers }, () => new Promise<number | null>(resolve => {
    const child = spawn(process.execPath, [worker, dir, String(rounds)], { stdio: 'ignore' });
    child.on('exit', resolve);
  })));
  assert.deepEqual(exits, Array(workers).fill(0));
  assert.equal(await fs.readFile(path.join(dir, 'errors.log'), 'utf8').catch(() => ''), '');
  assert.equal(Number(await fs.readFile(path.join(dir, 'counter.txt'), 'utf8')), workers * rounds);
  assert.deepEqual((await fs.readdir(dir)).filter(name => name.includes('.lock')), []);
});

const HOUR = 3_600_000;
const uuid = () => randomUUID();
const aged = async (target: string, ms: number) => { const when = new Date(Date.now() - ms); await fs.utimes(target, when, when); };

async function debris(root: string) {
  const folders = [root, path.join(root, 'archive'), path.join(root, 'backups')];
  for (const folder of folders) await fs.mkdir(folder, { recursive: true });
  const old = [
    path.join(root, `usage-v3.json.${process.pid}.${uuid()}.tmp`),
    path.join(root, 'archive', `history-ledger-v3.json.4242.${uuid()}.tmp`),
    path.join(root, 'backups', 'usage-v3-2026-11-20.json.777.tmp'),
  ];
  const keep = [
    path.join(root, `usage-v3.json.${process.pid}.${uuid()}.tmp`),
    path.join(root, 'notes.tmp'),
    path.join(root, 'usage-v3.json'),
    path.join(root, 'backups', 'usage-v3-2026-11-19.json'),
  ];
  for (const file of [...old, ...keep]) await fs.writeFile(file, 'x');
  for (const file of [...old, keep[1], keep[2], keep[3]]) await aged(file, 3 * HOUR);
  const displacedOld = path.join(root, `usage-v3.json.lock.stale-${process.pid}-${uuid()}`);
  const displacedNew = path.join(root, `usage-v3.json.lock.stale-${process.pid}-${uuid()}`);
  for (const dir of [displacedOld, displacedNew]) { await fs.mkdir(dir); await fs.writeFile(path.join(dir, 'owner'), 'x'); }
  await aged(displacedOld, 3 * HOUR);
  return { old: [...old, displacedOld], keep: [...keep, displacedNew] };
}

const exists = (target: string) => fs.stat(target).then(() => true, () => false);

test('sweeping removes temp files and moved-aside locks over an hour old, and only those', async () => {
  const root = await temporaryDirectory('sweep-');
  const { old, keep } = await debris(root);
  await sweepStale([root, path.join(root, 'archive'), path.join(root, 'backups'), path.join(root, 'missing')]);
  for (const target of old) assert.equal(await exists(target), false, target);
  for (const target of keep) assert.equal(await exists(target), true, target);
});

test('the sweep runs once per folder in a process, from the first transaction', async () => {
  const root = await temporaryDirectory('sweep-once-');
  const file = path.join(root, 'usage-v3.json');
  const { old } = await debris(root);
  await fs.rm(file);
  const store = await UsageStore.load(file);
  await store.transaction(() => undefined);
  for (const target of old) assert.equal(await exists(target), false, target);
  const later = path.join(root, `usage-v3.json.${process.pid}.${uuid()}.tmp`);
  await fs.writeFile(later, 'x');
  await aged(later, 3 * HOUR);
  await store.transaction(() => undefined);
  assert.equal(await exists(later), true, 'not swept a second time');
  await sweepOncePerProcess([root]);
  assert.equal(await exists(later), true);
});

test('a sweep that cannot read a folder carries on', async () => {
  const root = await temporaryDirectory('sweep-errors-');
  await fs.writeFile(path.join(root, 'a-file'), 'x');
  await sweepStale([path.join(root, 'a-file'), path.join(root, 'nothing-here')]);
});
