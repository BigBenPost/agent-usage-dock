import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ANTHROPIC_RATES, CODEX_RATES, CURSOR_RATES, DEFAULT_RATES, Pricing, referenceModel, type RateEntry } from '../src/pricing';
import type { Source, Tokens } from '../src/types';

const keysOf = (entry: RateEntry): string[] => [entry.match].flat();
const price = (rate?: { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; output: number }) =>
  rate && [rate.input, rate.cacheRead, rate.cacheWrite, rate.cacheWrite1h ?? rate.cacheWrite, rate.output];
const rateOf = (model: string, source: Source = 'claude', pricing = new Pricing()) => price(pricing.rateFor(model, source));
const entryRate = (entry: RateEntry) => price(entry);
const tokens = (over: Partial<Tokens> = {}): Tokens => ({ input: 1e6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1e6, ...over });

const TABLES: [string, Source, RateEntry[]][] = [['Anthropic', 'claude', ANTHROPIC_RATES], ['Codex', 'codex', CODEX_RATES], ['Antigravity', 'antigravity', DEFAULT_RATES]];

test('every key in every table resolves to its own entry', () => {
  for (const [name, source, entries] of TABLES) {
    for (const entry of entries) for (const key of keysOf(entry)) {
      assert.deepEqual(rateOf(key, source), entryRate(entry), `${name}: ${key}`);
      assert.equal(new Pricing().rateFor(key, source)?.note, entry.note, `${name}: ${key}`);
    }
  }
  for (const entry of ANTHROPIC_RATES) for (const key of keysOf(entry)) assert.deepEqual(rateOf(key, 'antigravity'), entryRate(entry), `Antigravity reaches ${key}`);
});

test('no key is cut off in the middle of a release date, which no spelling of the model could reach', () => {
  for (const [name, , entries] of TABLES) for (const entry of entries) for (const key of keysOf(entry)) {
    assert.doesNotMatch(key, /-\d{2,7}$/, `${name}: ${key}`);
    assert.equal(referenceModel(key), key.toLowerCase(), `${name}: ${key} is not in the form lookups use`);
  }
});

test('the Antigravity table holds no Claude rows, and a Claude model has the same rates from either source', () => {
  for (const entry of DEFAULT_RATES) for (const key of keysOf(entry)) assert.doesNotMatch(key, /^claude/, key);
  for (const entry of ANTHROPIC_RATES) for (const key of keysOf(entry)) {
    assert.deepEqual(rateOf(key, 'antigravity'), rateOf(key, 'claude'), key);
    const dotted = key.replace(/(\d)-(\d)/, '$1.$2');
    assert.deepEqual(rateOf(dotted, 'antigravity'), rateOf(key, 'claude'), dotted);
    assert.deepEqual(rateOf(dotted, 'claude'), rateOf(key, 'claude'), dotted);
  }
  assert.deepEqual(rateOf('claude-opus-4.6', 'antigravity'), [5, 0.5, 6.25, 10, 25]);
  assert.deepEqual(rateOf('claude-opus-4-5', 'antigravity'), [5, 0.5, 6.25, 10, 25]);
  assert.deepEqual(rateOf('claude-3-opus', 'antigravity'), [15, 1.5, 18.75, 30, 75]);
  assert.deepEqual(rateOf('claude-sonnet-4.6', 'antigravity'), [3, 0.3, 3.75, 6, 15]);
});

test('no price changed except the Claude rows of the Antigravity table, which now follow the Anthropic table', () => {
  const rows = (entries: RateEntry[]) => entries.map(entry => `${keysOf(entry).join(',')}: ${[entry.input, entry.cacheRead, entry.cacheWrite, entry.cacheWrite1h ?? '-', entry.output].join('/')}`);
  assert.deepEqual(rows(ANTHROPIC_RATES), [
    'claude-sonnet-5-5: 2/0.1/2.5/4/10',
    'claude-fable-5-1,claude-mythos-5-1: 10/0.25/12.5/20/50',
    'claude-fable-5,claude-mythos-5: 10/1/12.5/20/50',
    'claude-opus-5-5: 4/0.2/5/8/20',
    'claude-opus-5: 5/0.5/6.25/10/25',
    'claude-opus-4,claude-opus-4-1,claude-3-opus: 15/1.5/18.75/30/75',
    'claude-opus-4-5,claude-opus-4-6,claude-opus-4-7,claude-opus-4-8: 5/0.5/6.25/10/25',
    'claude-sonnet-5: 2/0.2/2.5/4/10',
    'claude-sonnet-4,claude-sonnet-4-5,claude-sonnet-4-6,claude-3-5-sonnet,claude-3-7-sonnet: 3/0.3/3.75/6/15',
    'claude-haiku-5-5: 0.1/0.01/0.125/0.2/0.5',
    'claude-haiku-4-5: 1/0.1/1.25/2/5',
    'claude-3-5-haiku: 0.8/0.08/1/1.6/4',
    'claude-3-haiku: 0.25/0.025/0.3125/0.5/1.25',
  ]);
  assert.deepEqual(rows(CODEX_RATES), [
    'gpt-6.2-astra: 8/0.4/10/-/40', 'gpt-6.2-sol: 2/0.1/2.5/-/10', 'gpt-6.1-sol: 2/0.1/2.5/-/10', 'gpt-6.1-terra: 1/0.05/1.25/-/5',
    'gpt-6-astra: 10/1/12.5/-/50', 'gpt-6-sol: 2/0.2/2.5/-/10', 'gpt-6-luna: 0.1/0.01/0.125/-/0.5', 'gpt-5.6-sol: 4/0.4/5/-/20',
    'gpt-5.6-terra: 2/0.2/2.5/-/12', 'gpt-5.6-luna: 0.2/0.02/0.25/-/1.2', 'gpt-5.5-fast: 10/1/10/-/60', 'gpt-5.5: 5/0.5/5/-/30', 'gpt-5.4: 2.5/0.25/2.5/-/15',
    'gpt-5.3-codex: 1.75/0.175/1.75/-/14', 'gpt-5.2,gpt-5.2-codex: 1.75/0.175/1.75/-/14', 'gpt-5,gpt-5-codex,gpt-5.1,gpt-5.1-codex: 1.25/0.125/1.25/-/10',
  ]);
  assert.deepEqual(rows(CURSOR_RATES), [
    'composer-2.5: 0.5/0.2/0.5/-/2.5', 'composer-2.5-fast: 3/0.5/3/-/15', 'composer-2: 0.5/0.2/0.5/-/2.5', 'composer-2-fast: 1.5/0.35/1.5/-/7.5', 'composer-1: 1.25/0.125/1.25/-/10',
    'cursor-auto: 1.25/0.25/1.25/-/6', 'cursor-agent-review: 5/0.5/6.25/-/25',
  ]);
  assert.deepEqual(rows(DEFAULT_RATES), [
    'gemini-1.5-flash-8b,gemini-flash-lite,flash_lite,gemini-2.0-flash-lite: 0.0375/0.01/0.0375/-/0.15',
    'gemini-1.5-flash: 0.075/0.01875/0.075/-/0.3',
    'gemini-2.0-flash,gemini-2.0-flash-exp,gemini-2.5-flash: 0.1/0.025/0.1/-/0.4',
    'gemini-3.8-flash: 0.75/0.075/0.75/-/3.75',
    'gemini-1.5-pro,gemini-1.5-pro-exp,gemini-2.5-pro: 1.25/0.3125/1.25/-/5',
    'gemini-3-pro,gemini-3-pro-preview,gemini-3.1-pro,gemini-3.1-pro-preview: 2/0.2/2/-/12',
    'gemini-3.5-flash: 1.5/0.15/1.5/-/9',
    'gemini-4-hydrogen,gemini-4-hydrogen-tiered-high: 1.5/0.075/1.5/-/7.5',
    'gemini-4-neon: 3/0.15/3/-/15',
    'gemini-4-argon: 2/0.1/2/-/10',
    'gemini-4-carbon: 2/0.1/2/-/10',
    'gemini-1.0-pro: 0.5/0.5/0.5/-/1.5',
    'gpt-4o-mini: 0.15/0.075/0.15/-/0.6',
    'o3-mini,o1-mini: 1.1/0.55/1.1/-/4.4',
    'o1,o3: 15/7.5/15/-/60',
    'gpt-4o: 2.5/1.25/2.5/-/10',
  ]);
});

const OPUS_4 = [15, 1.5, 18.75, 30, 75];
const SONNET_4 = [3, 0.3, 3.75, 6, 15];
const SPELLINGS: [string, number[]][] = [
  ['claude-opus-4-20250514', OPUS_4],
  ['claude-opus-4-1-20250805', OPUS_4],
  ['claude-opus-4.1', OPUS_4],
  ['claude-3-opus-20240229', OPUS_4],
  ['claude-sonnet-4-20250514', SONNET_4],
  ['claude-sonnet-4-5-20250929', SONNET_4],
  ['claude-sonnet-4.5', SONNET_4],
  ['claude-3-5-sonnet-20241022', SONNET_4],
  ['claude-3-5-sonnet-latest', SONNET_4],
  ['claude-3.5-sonnet', SONNET_4],
  ['claude-3.7-sonnet', SONNET_4],
  ['claude-3-7-sonnet-20250219', SONNET_4],
  ['claude-sonnet-4-5@20250929', SONNET_4],
  ['claude-sonnet-4@20250514', SONNET_4],
  ['claude-3-5-sonnet-v2@20241022', SONNET_4],
  ['anthropic.claude-3-5-sonnet-20241022-v2:0', SONNET_4],
  ['us.anthropic.claude-sonnet-4-20250514-v1:0', SONNET_4],
  ['eu.anthropic.claude-opus-4-1-20250805-v1:0', OPUS_4],
  ['global.anthropic.claude-sonnet-4-5-20250929-v1:0', SONNET_4],
  ['apac.anthropic.claude-sonnet-4-5-20250929-v1:0', SONNET_4],
  ['anthropic/claude-sonnet-4.5', SONNET_4],
  ['anthropic/claude-3.5-sonnet', SONNET_4],
  ['publishers/anthropic/models/claude-sonnet-4-5@20250929', SONNET_4],
  ['Claude-Sonnet-4-5-20250929', SONNET_4],
  ['claude-haiku-4-5-20251001', [1, 0.1, 1.25, 2, 5]],
  ['claude-3-5-haiku-latest', [0.8, 0.08, 1, 1.6, 4]],
  ['claude-3-haiku-20240307', [0.25, 0.025, 0.3125, 0.5, 1.25]],
  ['claude-opus-4-5-20251101', [5, 0.5, 6.25, 10, 25]],
  ['claude-sonnet-5-5-20261001', [2, 0.1, 2.5, 4, 10]],
];

test('a model is priced under every spelling a provider or API gives it', () => {
  for (const [spelling, expected] of SPELLINGS) {
    assert.deepEqual(rateOf(spelling, 'claude'), expected, spelling);
    assert.deepEqual(rateOf(spelling, 'antigravity'), expected, `${spelling} in Antigravity`);
  }
  for (const spelling of ['gpt-6.2-sol-2026-11-20', 'gpt-6.2-sol-20261120', 'GPT-6.2-Sol', 'gpt-6.2-sol-high']) assert.deepEqual(rateOf(spelling, 'codex'), [2, 0.1, 2.5, 2.5, 10], spelling);
  assert.deepEqual(rateOf('gemini-1.5-flash-latest', 'antigravity'), [0.075, 0.01875, 0.075, 0.075, 0.3]);
  assert.deepEqual(rateOf('models/gemini-2.5-flash', 'antigravity'), [0.1, 0.025, 0.1, 0.1, 0.4]);
  for (const spelling of ['gemini-4-hydrogen', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-tiered-high', 'GEMINI-4-HYDROGEN-TIERED-HIGH', 'models/gemini-4-hydrogen']) assert.deepEqual(rateOf(spelling, 'antigravity'), [1.5, 0.075, 1.5, 1.5, 7.5], spelling);
  for (const spelling of ['gemini-4-neon', 'gemini-4-neon-xhigh', 'models/gemini-4-neon']) assert.deepEqual(rateOf(spelling, 'antigravity'), [3, 0.15, 3, 3, 15], spelling);
  for (const spelling of ['gemini-4-argon', 'gemini-4-argon-minimal', 'gemini-4-carbon', 'gemini-4-carbon-high']) assert.deepEqual(rateOf(spelling, 'antigravity'), [2, 0.1, 2, 2, 10], spelling);
});

test('spellings that name no priced model stay unpriced', () => {
  for (const [model, source] of [['claude-opus-4-10', 'claude'], ['claude-fable-5-2', 'claude'], ['claude-opus-4-20', 'claude'], ['gpt-99-unlisted', 'codex'], ['gemini-2.5-flash-lite', 'antigravity'], ['gpt-oss-120b', 'antigravity'], ['mystery-model', 'claude']] as const) {
    assert.equal(new Pricing().rateFor(model, source), undefined, model);
  }
});

test('referenceModel strips what the price tables do not spell', () => {
  assert.equal(referenceModel('Anthropic/Claude-Sonnet-4.5'), 'claude-sonnet-4-5');
  assert.equal(referenceModel('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5');
  assert.equal(referenceModel('claude-3-5-haiku-latest'), 'claude-3-5-haiku');
  assert.equal(referenceModel('us.anthropic.claude-opus-4-1-20250805-v1:0'), 'claude-opus-4-1');
  assert.equal(referenceModel('gpt-6.2-sol-2026-11-20'), 'gpt-6.2-sol');
  assert.equal(referenceModel('o3-mini'), 'o3-mini');
});

test('an override applies to a dated or prefixed spelling of the model it names, and the exact spelling wins', () => {
  const sonnet = { input: 99, cacheRead: 98, cacheWrite: 97, output: 96 };
  const pricing = new Pricing({
    'codex/gpt-6.2-sol': { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
    'claude/claude-sonnet-4-5': sonnet,
    'claude/claude-sonnet-4-5-20250929': { input: 7 },
  });
  const overridden = (model: string, source: Source) => pricing.rateFor(model, source)?.overridden;
  assert.deepEqual([overridden('gpt-6.2-sol', 'codex'), overridden('gpt-6.2-sol-2026-11-20', 'codex'), pricing.rateFor('gpt-6.2-sol-2026-11-20', 'codex')?.input], [true, true, 1]);
  assert.equal(pricing.rateFor('claude-sonnet-4-5', 'claude')?.input, 99);
  for (const spelling of ['claude-sonnet-4-5@20250929'.replace('@20250929', '-20251001'), 'claude-sonnet-4-5@20251001', 'anthropic.claude-sonnet-4-5-20251001-v1:0', 'anthropic/claude-sonnet-4.5']) {
    assert.equal(pricing.rateFor(spelling, 'claude')?.input, 99, spelling);
    assert.equal(pricing.rateFor(spelling, 'claude')?.output, 96, spelling);
  }
  assert.equal(pricing.rateFor('claude-sonnet-4-5-20250929', 'claude')?.input, 7, 'the exact spelling wins over its reference form');
  assert.equal(pricing.rateFor('claude-sonnet-4-5-20250929', 'claude')?.output, 15, 'and replaces that override, as an exact key replaces a wildcard');
  assert.equal(overridden('claude-sonnet-4-5-20250929', 'antigravity'), false, 'other sources are untouched');
});

test('wildcard and unscoped overrides match the raw id and its reference form', () => {
  const pricing = new Pricing({ 'claude/claude-opus-4-*': { output: 11 }, 'gpt-6.2-*': { output: 12 }, 'codex/gpt-6.2-sol': { input: 5 } });
  assert.equal(pricing.rateFor('claude-opus-4-1-20250805', 'claude')?.output, 11);
  assert.equal(pricing.rateFor('us.anthropic.claude-opus-4-1-20250805-v1:0', 'claude')?.output, 11, 'matches the reference form');
  assert.equal(pricing.rateFor('claude-opus-5', 'claude')?.output, 25);
  assert.equal(pricing.rateFor('gpt-6.2-sol-2026-11-20', 'codex')?.output, 12);
  assert.equal(pricing.rateFor('gpt-6.2-sol-2026-11-20', 'codex')?.input, 5, 'a scoped exact override beats a bare wildcard for its own field');
  const routed = new Pricing({ 'dsh[route]/model-x': { input: 3 }, 'dsh/model-x': { input: 2 } });
  assert.equal(routed.rateFor('model-x', 'dsh', 'route')?.input, 3);
  assert.equal(routed.rateFor('model-x', 'dsh', 'other')?.input, 2);
});

test('the estimate note says user override when any rate is overridden', () => {
  const quote = (pricing: Pricing, source: Source, model: string) => pricing.quote({ source, model, tokens: tokens() });
  const built = quote(new Pricing(), 'claude', 'claude-sonnet-5-5');
  assert.match(built.note ?? '', /Historical Anthropic reference/);
  assert.equal(built.rate?.overridden, false);
  const full = { input: 99, cacheRead: 99, cacheWrite: 99, cacheWrite1h: 99, output: 99 };
  for (const override of [full, { output: 99 }]) {
    const note = quote(new Pricing({ 'claude/claude-sonnet-5-5': override }), 'claude', 'claude-sonnet-5-5').note;
    assert.equal(note, 'User override', JSON.stringify(override));
  }
  assert.equal(quote(new Pricing({ 'claude-sonnet-5-5-20261001': full }), 'claude', 'claude-sonnet-5-5-20261001').note, 'User override');
  assert.equal(quote(new Pricing({ 'gemini-1.5-flash': { output: 1 } }), 'antigravity', 'gemini-1.5-flash').note, 'User override');
  assert.equal(quote(new Pricing(), 'antigravity', 'gemini-1.5-flash').note, undefined);
  assert.equal(quote(new Pricing({ 'dsh/model-x': { input: 1, output: 1 } }), 'dsh', 'model-x').note, 'Custom fixed rate');
});

test('cost and breakdown are gone, and quote still answers for a known and an unknown model', () => {
  const pricing = new Pricing() as unknown as Record<string, unknown>;
  assert.equal(pricing.cost, undefined);
  assert.equal(pricing.breakdown, undefined);
  const known = new Pricing().quote({ source: 'claude', model: 'claude-opus-4-20250514', tokens: tokens() });
  assert.equal(known.cost, 15 + 75);
  assert.equal(known.unpriced, false);
  assert.equal(new Pricing().quote({ source: 'claude', model: 'claude-opus-4-10', tokens: tokens() }).unpriced, true);
});
