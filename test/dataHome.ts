/** Points every default location of the shared store, and the home folder, at `dir` while `run` executes. */
export async function withDataHome<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const names = ['HOME', 'USERPROFILE', 'AGY_TOKEN_TRACKER_HOME', 'AGY_TOKEN_MONITOR_HOME'] as const;
  const saved = names.map(name => process.env[name]);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.AGY_TOKEN_TRACKER_HOME = dir;
  delete process.env.AGY_TOKEN_MONITOR_HOME;
  try { return await run(); }
  finally { names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; }); }
}
