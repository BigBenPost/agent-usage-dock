import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { refreshUsage } from '../src/scan';
import { UsageStore } from '../src/store';

test('refreshUsage reads Antigravity transcripts from the brain directory', async () => {
  const root = await temporaryDirectory('agy-scan-');
  const home = path.join(root, 'agy');
  const logsDir = path.join(home, 'brain', 'conv-1', '.system_generated', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const line = JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-07T10:00:00Z',
    input_tokens: 1000,
    output_tokens: 200,
  });
  await fs.writeFile(path.join(logsDir, 'transcript.jsonl'), `${line}\n`);

  const file = path.join(root, 'usage-v3.json');
  const store = await UsageStore.load(file);
  const result = await refreshUsage(store, file, home);
  assert.deepEqual(result.problems, []);
  const record = store.data.records['antigravity:conv-1:1'];
  assert.equal(record.source, 'antigravity');
  assert.equal(record.tokens.input, 1000);
  assert.equal(record.tokens.output, 200);
});
