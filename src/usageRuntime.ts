import * as path from 'path';
import { Worker } from 'worker_threads';
import type { Config } from './config';
import type { StoreData } from './store';
import type { refreshUsage } from './scan';

/** UI facts only: the request ledger stays in the worker, never cloned into the extension host. */
export type UsageSnapshot = Omit<StoreData, 'records'>;
export type RefreshResult = Awaited<ReturnType<typeof refreshUsage>>;
export interface RuntimeReply { data: UsageSnapshot; result?: RefreshResult; recovered?: string[]; pruneError?: string }

/** A persistent worker owns loading, reconciliation, serialization and ledger I/O. */
export class UsageRuntime {
  private worker?: Worker;
  private nextId = 0;
  private disposed = false;
  private pending = new Map<number, { resolve: (reply: RuntimeReply) => void; reject: (error: Error) => void }>();

  load(): Promise<RuntimeReply> { return this.request({ type: 'load' }); }
  refresh(cfg: Config, rebuild = false): Promise<RuntimeReply> {
    // VS Code configuration objects can contain Proxy wrappers that fail worker_threads structured cloning.
    return this.request({ type: 'refresh', cfg: JSON.parse(JSON.stringify(cfg)) as Config, rebuild });
  }

  private request(message: object): Promise<RuntimeReply> {
    if (this.disposed) return Promise.reject(new Error('Usage worker disposed'));
    const worker = this.worker ??= this.start();
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id });
    });
  }

  private start(): Worker {
    const worker = new Worker(path.join(__dirname, 'usageWorker.js'));
    worker.on('message', (message: { id: number; error?: string; reply: RuntimeReply }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.reply);
      if (!this.pending.size) worker.unref();
    });
    const failed = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    worker.on('error', failed);
    worker.on('exit', code => failed(new Error('Usage worker exited: ' + code)));
    return worker;
  }

  dispose(): void {
    this.disposed = true;
    const worker = this.worker;
    if (!worker) return;
    // Let an in-progress transaction finish or abort cooperatively so its lock is released.
    worker.postMessage({ type: 'dispose' });
    const timer = setTimeout(() => void worker.terminate(), 5000);
    timer.unref();
    worker.once('exit', () => clearTimeout(timer));
    worker.unref();
  }
}
