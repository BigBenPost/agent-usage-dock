import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { backupDir, dailyBackup, rebuildBackup } from '../src/backup';
import { UsageStore } from '../src/store';

async function storeFile(content = '{"version":1,"days":{}}'): Promise<string> {
  const file = path.join(await temporaryDirectory('ai-usage-backup-'), 'usage.json');
  await fs.writeFile(file, content);
  return file;
}

const names = async (file: string): Promise<string[]> => (await fs.readdir(backupDir(file))).sort();
const noon = (day: string): number => Date.parse(`${day}T12:00:00Z`);

test('the first write of a UTC day keeps the store as it stood, and later ones that day leave that copy alone', async () => {
  const file = await storeFile('{"stage":"before"}');
  await dailyBackup(file, noon('2026-10-21'));
  await fs.writeFile(file, '{"stage":"after"}');
  await dailyBackup(file, noon('2026-10-21') + 3_600_000);
  assert.deepEqual(await names(file), ['usage-v3-2026-10-21.json']);
  assert.equal(await fs.readFile(path.join(backupDir(file), 'usage-v3-2026-10-21.json'), 'utf8'), '{"stage":"before"}');
  await dailyBackup(file, noon('2026-10-22'));
  assert.equal(await fs.readFile(path.join(backupDir(file), 'usage-v3-2026-10-22.json'), 'utf8'), '{"stage":"after"}');
});

test('only the newest seven daily copies are kept', async () => {
  const file = await storeFile();
  for (let d = 10; d <= 18; d++) await dailyBackup(file, noon(`2026-10-${d}`));
  assert.deepEqual(await names(file), ['12', '13', '14', '15', '16', '17', '18'].map((d) => `usage-v3-2026-10-${d}.json`));
});

test('with no store yet nothing is copied and no folder appears', async () => {
  const file = path.join(await temporaryDirectory('ai-usage-backup-'), 'usage.json');
  await dailyBackup(file);
  assert.equal(await rebuildBackup(file), undefined);
  await assert.rejects(fs.stat(backupDir(file)));
});

test('a copy before a rebuild has its own name and its own limit of five, apart from the daily ones', async () => {
  const file = await storeFile('{"history":true}');
  await dailyBackup(file, noon('2026-10-21'));
  const made: string[] = [];
  for (let i = 0; i < 7; i++) made.push((await rebuildBackup(file, noon('2026-10-21') + i * 1000)) as string);
  const all = await names(file);
  assert.equal(all.filter((n) => n.startsWith('usage-v3-pre-rebuild-')).length, 5);
  assert.ok(all.includes('usage-v3-2026-10-21.json'));
  assert.equal(await fs.readFile(made[6], 'utf8'), '{"history":true}');
  assert.match(path.basename(made[6]), /^usage-v3-pre-rebuild-2026-10-21T12-00-06-000Z\.json$/);
  assert.ok(!all.some((n) => n.endsWith('.tmp')));
});

test('a transaction takes the daily copy of the file it has just read', async () => {
  const file = await storeFile('{"version":1,"days":{"2026-10-20":{"antigravity":{"m":{"requests":3,"input":0,"cacheRead":0,"cacheWrite":0,"cacheWrite1h":0,"output":9}}}}}');
  const store = await UsageStore.load(file);
  await store.transaction(() => store.markDirty());
  const [copy] = await names(file);
  assert.match(copy, /^usage-v3-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(JSON.parse(await fs.readFile(path.join(backupDir(file), copy), 'utf8')).days['2026-10-20'].antigravity.m.requests, 3);
});

test('a backup that cannot be made does not stop the store from saving', async () => {
  const file = await storeFile();
  await fs.writeFile(backupDir(file), 'a file where the folder should be');
  const store = await UsageStore.load(file);
  await store.transaction(() => {
    store.data.firstDay = '2026-10-20';
    store.markDirty();
  });
  assert.equal((await UsageStore.load(file)).data.firstDay, '2026-10-20');
});
