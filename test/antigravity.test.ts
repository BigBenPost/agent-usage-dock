import { temporaryDirectory } from './temp';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  decodeProtoFields,
  normalizeAntigravityModel,
  parseAntigravityLine,
  parseDbStepMetadata,
  scanAntigravity,
} from '../src/collectors/antigravity';
import { normalizeConfig } from '../src/configValues';
import { Pricing } from '../src/pricing';
import { statusBarLabel, statusBarText } from '../src/statusText';
import { formatTokensCompact, splitCompactTokens, summarize } from '../src/summary';
import { chartSvg, tooltipMarkdown } from '../src/tooltip';

test('normalizeAntigravityModel normalizes Gemini models and sanitizes strings', () => {
  assert.equal(normalizeAntigravityModel('Gemini 3.8 Flash (High)'), 'gemini-3.8-flash');
  assert.equal(normalizeAntigravityModel('Gemini 4 Hydrogen (High)'), 'gemini-4-hydrogen');
  assert.equal(normalizeAntigravityModel('Gemini 4 Neon'), 'gemini-4-neon');
  assert.equal(normalizeAntigravityModel('Gemini 4 Carbon (Medium)'), 'gemini-4-carbon');
  assert.equal(normalizeAntigravityModel('Gemini 1.5 Pro'), 'gemini-1.5-pro');
  assert.equal(normalizeAntigravityModel('gemini-flash-lite'), 'gemini-flash-lite');
  assert.equal(normalizeAntigravityModel('gemini-1.5-flash'), 'gemini-1.5-flash');
});

test('parseAntigravityLine correctly parses steps with input, output, and cache read tokens', () => {
  const line = JSON.stringify({
    step_index: 42,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-07T12:30:00Z',
    input_tokens: 12500,
    cache_read_tokens: 45000,
    output_tokens: 850,
  });

  const rec = parseAntigravityLine(
    line,
    'session-abc',
    { title: 'Feature Development', project: 'Workspace', lastModifiedMs: Date.now() },
    'gemini-3.8-flash',
  );

  assert.ok(rec);
  assert.equal(rec.id, 'antigravity:session-abc:42');
  assert.equal(rec.source, 'antigravity');
  assert.equal(rec.day, '2026-11-07');
  assert.equal(rec.model, 'gemini-3.8-flash');
  assert.equal(rec.session, 'session-abc');
  assert.equal(rec.title, 'Feature Development');
  assert.equal(rec.project, 'Workspace');
  assert.deepEqual(rec.tokens, {
    input: 12500,
    cacheRead: 45000,
    cacheWrite: 0,
    cacheWrite1h: 0,
    output: 850,
  });
});

test('compact token formatting functions handle B, M, and k scales cleanly', () => {
  assert.equal(formatTokensCompact(47_929_525), '47.9M');
  assert.equal(formatTokensCompact(712_252), '712k');
  assert.equal(formatTokensCompact(1_500_000_000), '1.5B');
  assert.equal(formatTokensCompact(850), '850');
  assert.equal(formatTokensCompact(0), '0');

  assert.deepEqual(splitCompactTokens(47_929_525), { whole: '47', fraction: '.9M' });
  assert.deepEqual(splitCompactTokens(712_252), { whole: '712', fraction: 'k' });
  assert.deepEqual(splitCompactTokens(1_500_000_000), { whole: '1', fraction: '.5B' });
  assert.deepEqual(splitCompactTokens(500), { whole: '500', fraction: '' });
});

test('scanAntigravity reads transcript.jsonl from an Antigravity brain directory', async () => {
  const root = await temporaryDirectory('agy-test-');
  const brainDir = path.join(root, 'brain');
  const cid = 'test-conversation-uuid';
  const transcriptDir = path.join(brainDir, cid, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });

  const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
  const step0 = JSON.stringify({
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    created_at: '2026-11-07T12:00:00Z',
    content: "<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment",
  });
  const step1 = JSON.stringify({
    step_index: 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-07T12:01:00Z',
    input_tokens: 5000,
    cache_read_tokens: 15000,
    output_tokens: 400,
  });
  await fs.writeFile(transcriptFile, `${step0}\n${step1}\n`);

  const files: Record<string, any> = {};
  const records: any[] = [];
  const count = await scanAntigravity(brainDir, path.join(root, 'empty.db'), files, (r) => records.push(r));

  assert.equal(count, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, `antigravity:${cid}:1`);
  assert.equal(records[0].model, 'gemini-3.8-flash');
  assert.equal(records[0].tokens.input, 5000);
  assert.equal(records[0].tokens.cacheRead, 15000);
  assert.equal(records[0].tokens.output, 400);
});

test('scanAntigravity inherits the last seen step model for CHECKPOINT lines without a model field', async () => {
  const root = await temporaryDirectory('agy-checkpoint-');
  const brainDir = path.join(root, 'brain');
  const cid = 'checkpoint-conversation';
  const transcriptDir = path.join(brainDir, cid, '.system_generated', 'logs');
  await fs.mkdir(transcriptDir, { recursive: true });

  const transcriptFile = path.join(transcriptDir, 'transcript.jsonl');
  const planner = JSON.stringify({
    step_index: 10,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    created_at: '2026-11-25T06:10:00Z',
    model: 'gemini-4-hydrogen-medium',
    input_tokens: 2000,
    cache_read_tokens: 100000,
    output_tokens: 500,
  });
  const checkpoint = JSON.stringify({
    step_index: 11,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    created_at: '2026-11-25T06:11:26Z',
    input_tokens: 4691,
    cache_read_tokens: 509189,
    output_tokens: 4519,
  });
  await fs.writeFile(transcriptFile, `${planner}\n${checkpoint}\n`);

  const files: Record<string, any> = {};
  const records: any[] = [];
  await scanAntigravity(brainDir, path.join(root, 'empty.db'), files, (r) => records.push(r));

  assert.equal(records.length, 2);
  assert.equal(records[0].model, 'gemini-4-hydrogen-medium');
  assert.equal(records[1].model, 'gemini-4-hydrogen-medium');
});

test('decodeProtoFields and parseDbStepMetadata extract tokens from protobuf step metadata', () => {
  const metaBuf = Buffer.from('0a0608ad9eafd7064a0c08a60a108827189003289875', 'hex');
  const fields = decodeProtoFields(metaBuf);
  assert.equal(fields.length, 2);

  const rec = parseDbStepMetadata(metaBuf, 'test-conv', 5);
  assert.ok(rec);
  assert.equal(rec.id, 'antigravity:test-conv:5');
  assert.equal(rec.model, 'gemini-3.8-flash');
  assert.equal(rec.tokens.input, 5000);
  assert.equal(rec.tokens.output, 400);
  assert.equal(rec.tokens.cacheRead, 15000);
});

test('Antigravity token summary displays in the status bar and hover tooltip', () => {
  const now = Date.parse('2026-11-07T14:00:00Z');
  const days = {
    '2026-11-07': {
      antigravity: {
        'gemini-3.8-flash': {
          requests: 10,
          input: 2_000_000,
          cacheRead: 45_000_000,
          cacheWrite: 0,
          cacheWrite1h: 0,
          output: 250_000,
        },
      },
    },
  };

  const storeData: any = {
    version: 1,
    days,
    sessions: {
      'antigravity:conv-1': {
        source: 'antigravity',
        id: 'conv-1',
        title: 'Antigravity Monitor Task',
        project: 'Personal',
        first: now,
        last: now,
        days,
      },
    },
    seen: {},
    open: {},
    files: {},
  };

  const s = summarize(storeData, new Pricing(), now);
  assert.equal(s.tokensTotal, 47_250_000);
  assert.equal(s.todayTokens, 47_250_000);

  // Status bar without token budget
  const cfgNoBudget = normalizeConfig({ tokenBudgetLimit: 0, budgetLimit: 0 });
  const textNoBudget = statusBarText(s, cfgNoBudget);
  assert.equal(textNoBudget, '47.3M | 47.3M');
  assert.equal(statusBarLabel(s, cfgNoBudget), 'agent-usage-dock: 47.3M today, 47.3M this month');

  // Status bar with 50M token budget (47.25M / 50M = 94.5% -> critical)
  const cfgWithBudget = normalizeConfig({ tokenBudgetLimit: 50 });
  const textWithBudget = statusBarText(s, cfgWithBudget);
  assert.equal(textWithBudget, '47.3M | 47.3M · 95%');
  assert.match(statusBarLabel(s, cfgWithBudget), /agent-usage-dock: 47\.3M today, 47\.3M this month, 95% of 50M/);

  // SVG hover card
  const svg = chartSvg(s, cfgWithBudget, false);
  assert.match(svg, /AGENT-USAGE-DOCK/);
  assert.match(svg, /of 50M budget/);
  assert.match(svg, /Today <tspan[^>]*>47\.3M<\/tspan>/);

  // Fallback markdown tooltip
  const mdText = tooltipMarkdown(s, cfgWithBudget, { dark: false, chart: false });
  assert.match(mdText, /\*\*agent-usage-dock\*\* · November 2026/);
  assert.match(mdText, /## ~47\.3M/);
  assert.match(mdText, /command:agyTokenTracker\.openPanel/);
  assert.doesNotMatch(mdText, /[\u4e00-\u9fff]/); // Strict English check
});
