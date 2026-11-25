// NODE_TEST_CONTEXT would make the suite a subtest of the node:test run that started it.
const ALWAYS_REMOVED = new Set(['ANTIGRAVITY_HOME', 'DSH_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'NODE_TEST_CONTEXT']);

/** Variables that point the code at real data or real tools. `AGY_TEST_*` are switches of the test suite itself and pass through. */
export function isRemoved(name) {
  const upper = name.toUpperCase();
  return ALWAYS_REMOVED.has(upper) || (upper.startsWith('AGY_') && !upper.startsWith('AGY_TEST_'));
}

function setVariable(env, name, value) {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  env[name] = value;
}

/** NODE_OPTIONS that preload `guard`, appended to what the caller already had. Values with spaces or backslashes need the quotes. */
export function nodeOptionsWithGuard(existing, guard) {
  const quoted = `"${guard.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (existing?.includes(quoted)) return existing;
  return `${existing ? `${existing} ` : ''}--require ${quoted}`;
}

/**
 * The environment a child that must not see the real machine runs in: HOME and USERPROFILE (and so os.homedir()) are `home`,
 * the variables that select data folders are gone, and the network guard is preloaded into every Node child.
 */
export function hermeticEnvironment(base, { home, temporary, guard }) {
  const env = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !isRemoved(name)) env[name] = value;
  setVariable(env, 'HOME', home);
  setVariable(env, 'USERPROFILE', home);
  if (temporary) for (const name of ['TMPDIR', 'TMP', 'TEMP', 'USAGE_MONITOR_TEST_TMP_ROOT']) setVariable(env, name, temporary);
  if (guard) {
    const existing = Object.keys(env).find((key) => key.toUpperCase() === 'NODE_OPTIONS');
    setVariable(env, 'NODE_OPTIONS', nodeOptionsWithGuard(existing && env[existing], guard));
  }
  return env;
}
