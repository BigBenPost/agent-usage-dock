import { parentPort } from 'worker_threads';
import type { Config } from './config';
import { claudeHome, codexHome, dataPaths, dshHome, initializeUsageStore, sharedStoreFile } from './paths';
import { refreshUsage } from './scan';
import type { UsageStore } from './store';
import type { RuntimeReply } from './usageRuntime';

const port = parentPort!;
const cancellation = new AbortController();
let store: UsageStore | undefined;
let pruned = false;
let queue = Promise.resolve();

port.on('message', (message: { id: number; type: string; cfg: Config; rebuild: boolean }) => {
  if (message.type === 'dispose') {
    cancellation.abort();
    void queue.finally(() => port.close());
    return;
  }
  queue = queue.then(async () => {
    try {
      cancellation.signal.throwIfAborted();
      const recovered: string[] = [];
      store ??= await initializeUsageStore(aside => recovered.push(aside));
      const reply: Partial<RuntimeReply> = { recovered };
      if (message.type === 'refresh') {
        const cfg = message.cfg;
        reply.result = await refreshUsage(store, sharedStoreFile(), cfg.antigravityHome, message.rebuild,
          { ...cfg, source: 'all', signal: cancellation.signal });
        if (!pruned) {
          const roots = [dataPaths(cfg.antigravityHome).home, dshHome(cfg.dshHome), claudeHome(cfg.claudeHome), codexHome(cfg.codexHome)];
          try { await store.transaction(() => store!.pruneFiles(roots), true); pruned = true; }
          catch (error) { reply.pruneError = String(error); }
        }
      }
      const { records: _records, ...data } = store.data;
      port.postMessage({ id: message.id, reply: { ...reply, data } });
    } catch (error) {
      port.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
  });
});
