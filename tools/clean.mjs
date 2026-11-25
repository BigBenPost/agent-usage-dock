#!/usr/bin/env node
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Removes build outputs so that nothing stale survives into a test run or a package: `node tools/clean.mjs [out] [dist]` (default: both). */
const project = fileURLToPath(new URL('../', import.meta.url));
const CLEANABLE = ['out', 'dist'];
const targets = process.argv.length > 2 ? process.argv.slice(2) : CLEANABLE;
const refused = targets.filter((target) => !CLEANABLE.includes(target));
if (refused.length) {
  console.error(`clean: only ${CLEANABLE.join(' and ')} can be removed, not ${refused.join(', ')}`);
  process.exit(2);
}
for (const target of targets) rmSync(path.join(project, target), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
