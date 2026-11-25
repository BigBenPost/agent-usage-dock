import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { acquireFileLock } from '../src/fileLock';

/** Child of fileLock.test.ts: `node lockWorker.js <folder> <rounds>`. Each round takes the lock, checks nobody else is inside, and bumps a counter. */
const [folder, rounds] = [process.argv[2], Number(process.argv[3])];
const target = path.join(folder, 'usage-v3.json');
const counter = path.join(folder, 'counter.txt');
const inside = path.join(folder, 'inside');
const complain = (text: string) => fs.appendFile(path.join(folder, 'errors.log'), `${process.pid} ${text}\n`);

(async () => {
  for (let i = 0; i < rounds; i++) {
    let lock;
    try { lock = await acquireFileLock(target); }
    catch (err) { await complain(`acquire: ${(err as Error).message}`); continue; }
    try {
      try { await fs.writeFile(inside, String(process.pid), { flag: 'wx' }); }
      catch { await complain('two holders at once'); }
      const n = Number(await fs.readFile(counter, 'utf8').catch(() => '0'));
      await new Promise(resolve => setTimeout(resolve, 2));
      await lock.assertHeld();
      await fs.writeFile(counter, String(n + 1));
      await fs.rm(inside, { force: true });
    } catch (err) {
      await complain(`body: ${(err as Error).message}`);
      await fs.rm(inside, { force: true });
    } finally { await lock.release(); }
  }
})().then(() => process.exit(0), () => process.exit(1));
