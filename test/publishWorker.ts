import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { acquireFileLock } from '../src/fileLock';
import { publishPrivateFile } from '../src/privateFiles';

/** Child of reviewIntegrity.test.ts: `node publishWorker.js <folder> <rounds>`. Each round takes the lock and commits the next counter value through it. */
const [folder, rounds] = [process.argv[2], Number(process.argv[3])];
const target = path.join(folder, 'usage-v3.json');
const counter = path.join(folder, 'counter.txt');
const complain = (text: string) => fs.appendFile(path.join(folder, 'errors.log'), `${process.pid} ${text}\n`);

(async () => {
  for (let i = 0; i < rounds; i++) {
    const lock = await acquireFileLock(target).catch(async (error: Error) => { await complain(`acquire: ${error.message}`); });
    if (!lock) continue;
    try {
      const n = Number(await fs.readFile(counter, 'utf8').catch(() => '0'));
      await publishPrivateFile(counter, String(n + 1), lock.assertHeld);
    } catch (error) {
      await complain(`publish: ${(error as Error).message}`);
    } finally { await lock.release(); }
  }
})().then(() => process.exit(0), () => process.exit(1));
