import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { renderBody } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { summarize, type Summary } from '../src/summary';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const cfg = normalizeConfig({});
const attemptedAt = new Date(NOW).toISOString();

type Health = NonNullable<Summary['sourceHealth']>;

function withHealth(sourceHealth: Health, problems: string[] = []): Summary {
  return summarize({ days: {}, health: { root: '/store', attemptedAt, succeededAt: attemptedAt, problems }, sourceHealth }, new Pricing(), NOW);
}

const ok = (root: string): Health[keyof Health] => ({ root, status: 'ok', attemptedAt, succeededAt: attemptedAt, problems: [] });
const absent = (root: string): Health[keyof Health] => ({ root, status: 'not-found', attemptedAt, problems: [] });

const header = (summary: Summary) => {
  const { document } = parseHTML(renderBody(summary, cfg));
  return { document, summary: document.querySelector('[data-key="collection-status"] > summary')! };
};

test('the collapsed header names every tool with its state, the ones that are not installed included', () => {
  const { summary } = header(withHealth({ antigravity: absent('/home/me/.gemini/antigravity'), dsh: absent('/home/me/.dsh'), claude: ok('/home/me/.claude'), codex: ok('/home/me/.codex') }));
  const chips = [...summary.querySelectorAll('.health-chip')];
  assert.deepEqual(chips.map((chip) => chip.textContent), ['AntigravityNot installed', 'DSHNot installed', 'Claude CodeReady', 'CodexReady', 'CursorNo data']);
  assert.deepEqual(chips.map((chip) => chip.getAttribute('class')!.replace('health-chip ', '')), ['absent', 'absent', 'ready', 'ready', 'absent']);
  assert.doesNotMatch(summary.textContent!, /Needs attention/, 'a tool that is not installed is not an issue');
  assert.doesNotMatch(summary.textContent!, /Not found/);
});

test('every state has its own wording: Ready, Incomplete, Disabled, Not installed, and Not scanned before the first scan', () => {
  const { summary } = header(withHealth({
    antigravity: ok('/a'),
    dsh: { root: '/d', status: 'incomplete', attemptedAt, problems: ['could not read'] },
    claude: { root: '/c', status: 'disabled', attemptedAt, problems: [] },
  }));
  assert.deepEqual([...summary.querySelectorAll('.health-chip')].map((chip) => chip.textContent), ['AntigravityReady', 'DSHIncomplete', 'Claude CodeDisabled', 'CodexNot scanned', 'CursorNo data']);
  assert.match(summary.querySelector('.health-flag')!.textContent!, /^Needs attention · 1 issue$/);
});

test('before the first scan the four tools that are scanned are listed as not scanned', () => {
  const { summary } = header(withHealth({}));
  assert.deepEqual([...summary.querySelectorAll('.health-chip em')].map((e) => e.textContent), ['Not scanned', 'Not scanned', 'Not scanned', 'Not scanned', 'No data']);
});

test('Cursor keeps nothing on this machine, so it is never scanned: it has records that were brought in, or it has none', () => {
  const none = header(withHealth({}));
  assert.match(none.document.querySelectorAll('.source-health')[4].textContent!, /CursorNo dataCursor keeps no usage on this machine, so its records come from a ledger that is brought in\./);
  assert.equal(none.document.querySelectorAll('.source-health')[4].querySelector('.health-facts'), null, 'no last success and no folder to name');
  const bucket = { requests: 1, input: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 1 };
  const brought = parseHTML(renderBody(summarize({ days: { '2026-09-02': { cursor: { 'composer-2.5': bucket } } }, health: { root: '/store', attemptedAt, succeededAt: attemptedAt, problems: [] } }, new Pricing(), NOW), cfg)).document;
  assert.deepEqual([...brought.querySelectorAll('.health-chip')].slice(-1).map((chip) => [chip.textContent, chip.getAttribute('class')]), [['CursorImported', 'health-chip ready']], 'the records may be in another month than the one on show');
  assert.match(brought.querySelectorAll('.source-health')[4].querySelector('.health-badge')!.getAttribute('class')!, /ready/);
  assert.doesNotMatch(brought.querySelector('[data-key="collection-status"] > summary')!.textContent!, /Needs attention/);
});

test('a source that is not installed has a card that says where it looked, with no last success to report', () => {
  const { document } = header(withHealth({ antigravity: ok('/a'), dsh: absent('/home/me/.dsh'), claude: ok('/c'), codex: ok('/x') }));
  const cards = [...document.querySelectorAll('.source-health')];
  assert.equal(cards.length, 5);
  assert.match(cards[1].textContent!, /DSHNot installedNo data folder at \/home\/me\/\.dsh\. DSH is not installed on this machine, or has not run here\./);
  assert.equal(cards[1].querySelector('.health-facts'), null);
  assert.equal(cards[1].querySelector('.diagnostic'), null);
  assert.match(cards[0].querySelector('.health-facts')!.textContent!, /Last success/);
});

test('the folder named on a card for an absent source is text, never markup', () => {
  const { document } = header(withHealth({ antigravity: absent('<b onclick="x">/nowhere</b>') }));
  const note = document.querySelector('.source-health .health-note')!;
  assert.equal(note.querySelector('b'), null);
  assert.match(note.textContent!, /<b onclick="x">\/nowhere<\/b>/);
});

test('trouble still comes first in the header, ahead of the four states, with the number of issues', () => {
  const { summary } = header(withHealth({ antigravity: absent('/a'), claude: { root: '/c', status: 'incomplete', attemptedAt, problems: ['one', 'two'] } }, ['three']));
  assert.match(summary.querySelector('.health-summary')!.firstElementChild!.textContent!, /^Needs attention · 3 issues$/);
});
