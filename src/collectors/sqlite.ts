import { Worker } from 'worker_threads';

const QUERY_TIMEOUT_MS = 15_000;

type Rows = Record<string, unknown>[];

const WORKER_SOURCE = `
  const { parentPort, workerData } = require('worker_threads');
  const { execFile } = require('child_process');
  let DatabaseSync;
  if (workerData.backend !== 'cli') try { ({ DatabaseSync } = require('node:sqlite')); } catch {}
  parentPort.on('message', ({ id, file, sql }) => {
    const reply = message => parentPort.postMessage({ id, ...message });
    if (DatabaseSync) {
      try {
        const db = new DatabaseSync(file, { readOnly: true });
        try { reply({ rows: db.prepare(sql).all() }); }
        finally { db.close(); }
      } catch (e) { reply({ error: e.message }); }
      return;
    }
    execFile(process.env.AGY_SQLITE3 || 'sqlite3', ['-readonly', '-json', file, sql],
      { timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) reply({ error: 'SQLite unavailable or query failed: ' + err.message });
        else { try { reply({ rows: JSON.parse(stdout || '[]') }); }
          catch (e) { reply({ error: e.message }); } }
      });
  });
`;

interface PendingQuery {
  resolve: (rows: Rows) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * SQLite work stays outside the extension host. A session owns one worker thread for a whole scan pass, started with the
 * first query. Every query has its own time limit; a query that overruns it, or a worker that dies, fails the pending
 * queries and the next query starts a fresh worker. Close the session when the pass ends.
 */
export class SqliteSession {
  private worker?: Worker;
  private readonly pending = new Map<number, PendingQuery>();
  private lastId = 0;
  private closed = false;
  private readonly abort = (): void => { void this.close(); };

  constructor(private readonly backend: 'auto' | 'cli' = 'auto', private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', this.abort, { once: true });
  }

  rows(file: string, sql: string): Promise<Rows> {
    if (this.signal?.aborted) return Promise.reject(this.signal.reason ?? new Error('SQLite query cancelled'));
    if (this.closed) return Promise.reject(new Error('SQLite session is closed'));
    const worker = this.worker ??= this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.lastId;
      const timer = setTimeout(() => { void this.fail(new Error('SQLite query timed out')); }, QUERY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, file, sql });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.signal?.removeEventListener('abort', this.abort);
    await this.fail(new Error('SQLite session is closed'));
  }

  private start(): Worker {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { backend: this.backend } });
    worker.on('message', (message: { id: number; rows?: Rows; error?: string }) => {
      const query = this.pending.get(message.id);
      if (!query || this.worker !== worker) return;
      this.pending.delete(message.id);
      clearTimeout(query.timer);
      if (message.error !== undefined) query.reject(new Error(message.error));
      else query.resolve(message.rows ?? []);
    });
    worker.on('error', error => { if (this.worker === worker) void this.fail(error); });
    worker.on('exit', code => { if (this.worker === worker) void this.fail(new Error('SQLite worker exited: ' + code)); });
    return worker;
  }

  private async fail(error: Error): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    for (const query of this.pending.values()) {
      clearTimeout(query.timer);
      query.reject(error);
    }
    this.pending.clear();
    await worker?.terminate();
  }
}

export async function sqliteRows(file: string, sql: string, backend: 'auto' | 'cli' = 'auto'): Promise<Rows> {
  const session = new SqliteSession(backend);
  try {
    return await session.rows(file, sql);
  } finally {
    await session.close();
  }
}
