import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHTML } from 'linkedom';
import { renderSessionDetail } from '../src/panelHtml';
import { Pricing } from '../src/pricing';
import { buildSessionDetail } from '../src/sessionDetail';
import type { SessionInfo } from '../src/sessionInfo';
import { emptyBucket, type SessionRecord } from '../src/types';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  source: 'antigravity', id: 'abc', first: NOW, last: NOW + 1000,
  days: { '2026-10-21': { 'gemini-1.5-flash': { ...emptyBucket(), requests: 1, output: 1e6 } } },
  ...over,
});

function popup(rec: SessionRecord, info?: SessionInfo) {
  const document = parseHTML(`<html><body>${renderSessionDetail(buildSessionDetail('antigravity:abc', rec, new Pricing(), '2026-10', info))}</body></html>`).document;
  return { title: document.querySelector('.pop-title')!.textContent, sub: document.querySelector('.pop-head .sub')?.textContent ?? null };
}

test('the session detail carries the title the store has for the session', () => {
  assert.equal(buildSessionDetail('antigravity:abc', record({ title: 'Plan the migration' }), new Pricing(), '2026-10').title, 'Plan the migration');
  assert.equal(buildSessionDetail('antigravity:abc', record(), new Pricing(), '2026-10').title, undefined);
});

test('the popup names a session by what its log says, then by the title the store has, then by its project, then plainly', () => {
  const file = { file: '/logs/abc.jsonl' };
  assert.deepEqual(popup(record({ title: 'Stored title', project: 'my-project' }), { ...file, title: 'Log title' }), { title: 'Log title', sub: 'my-project' });
  assert.deepEqual(popup(record({ title: 'Stored title', project: 'my-project' }), file), { title: 'Stored title', sub: 'my-project' });
  assert.deepEqual(popup(record({ title: 'Stored title', project: 'my-project' })), { title: 'Stored title', sub: 'my-project' }, 'an Antigravity session whose log is gone keeps its title');
  assert.deepEqual(popup(record({ project: 'my-project' }), file), { title: 'my-project', sub: null });
  assert.deepEqual(popup(record()), { title: 'Session', sub: null });
});

test('a blank title is no title, whichever place it comes from', () => {
  assert.deepEqual(popup(record({ title: '  ', project: 'my-project' }), { file: '/f', title: '' }), { title: 'my-project', sub: null });
  assert.deepEqual(popup(record({ title: 'Stored', project: ' ' }), { file: '/f', title: '   ' }), { title: 'Stored', sub: null });
  assert.deepEqual(popup(record({ title: '' }), undefined), { title: 'Session', sub: null });
});

test('the project is not repeated under a title that already is the project', () => {
  assert.deepEqual(popup(record({ title: 'my-project', project: 'my-project' })), { title: 'my-project', sub: null });
});
