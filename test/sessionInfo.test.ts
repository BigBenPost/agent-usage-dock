import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { findSessionLog, readSessionInfo } from '../src/sessionInfo';

async function tmp(): Promise<string> {
  return temporaryDirectory('agy-info-');
}

test('findSessionLog locates an Antigravity log by conversation id', async () => {
  const root = await tmp();
  const logsDir = path.join(root, 'conv-123', '.system_generated', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  const file = path.join(logsDir, 'transcript.jsonl');
  await fs.writeFile(file, '{}\n');

  assert.equal(await findSessionLog('antigravity', 'conv-123', root), file);
  assert.equal(await findSessionLog('antigravity', 'missing-conv', root), undefined);
  assert.equal(await findSessionLog('antigravity', '../escaped', root), undefined);
});

test('readSessionInfo reads the first user prompt from transcript', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'transcript.jsonl');
  const line1 = JSON.stringify({ type: 'USER_INPUT', content: 'Create a token monitor extension' });
  const line2 = JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 100 });
  await fs.writeFile(file, `${line1}\n${line2}\n`);

  const info = await readSessionInfo('antigravity', file);
  assert.equal(info.file, file);
  assert.equal(info.firstPrompt, 'Create a token monitor extension');
});
