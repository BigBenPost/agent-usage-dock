import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
import { parseHTML } from 'linkedom';
import { normalizeConfig } from '../src/configValues';
import { buildOfflineSnapshot, collectSessionInfos, ExportCancelledError, renderOfflineHtml } from '../src/offlineExport';
import { renderBody } from '../src/panelRender';
import { Pricing } from '../src/pricing';
import { summarize } from '../src/summary';
import { emptyBucket, type DayRecord, type SessionRecord, type TokenBucket } from '../src/types';
import { temporaryDirectory } from './temp';

const projectRoot = path.resolve(__dirname, '..', '..');
const NOW = Date.parse('2026-11-22T12:00:00Z');
const bucket = (requests: number, input: number, output: number): TokenBucket => ({ ...emptyBucket(), requests, input, output });

let cachedOfflineBundle: string | undefined;
function getOfflineBundle(): string {
  if (!cachedOfflineBundle) {
    const built = buildSync({
      entryPoints: [path.join(projectRoot, 'src', 'offlineApp.ts')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      target: 'es2020',
    });
    cachedOfflineBundle = built.outputFiles[0].text;
  }
  return cachedOfflineBundle;
}

test('collectSessionInfos gathers details across all sessions, degrades on missing logs, and respects cancellation', async () => {
  const root = await temporaryDirectory('offline-infos-');
  const claudeDir = path.join(root, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'proj-a');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(
    path.join(projDir, 's1.jsonl'),
    [
      JSON.stringify({ type: 'user', cwd: '/work/proj-a', gitBranch: 'main', message: { content: 'First </script> prompt' } }),
      JSON.stringify({ type: 'assistant', customTitle: 'Custom <script>alert(1)</script> Title', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ].join('\n') + '\n',
  );

  const sessions: Record<string, SessionRecord> = {
    'claude:s1': { source: 'claude', id: 's1', project: 'proj-a', first: NOW - 10_000, last: NOW - 5_000, days: { '2026-11-22': { 'claude-sonnet-5-5': bucket(1, 100, 50) } } },
    'claude:missing': { source: 'claude', id: 'missing', project: 'proj-b', first: NOW - 20_000, last: NOW - 15_000, days: { '2026-11-22': { 'claude-sonnet-5-5': bucket(1, 100, 50) } } },
  };
  const cfg = { antigravityHome: path.join(root, 'agy'), dshHome: path.join(root, 'dsh'), claudeHome: claudeDir, codexHome: path.join(root, 'codex') };
  const progress: [number, number][] = [];

  const infos = await collectSessionInfos(sessions, {}, cfg, {
    concurrency: 2,
    onProgress: (done, total) => progress.push([done, total]),
  });

  assert.equal(infos['claude:s1']?.title, 'Custom <script>alert(1)</script> Title');
  assert.equal(infos['claude:s1']?.firstPrompt, 'First </script> prompt');
  assert.equal(infos['claude:s1']?.cwd, '/work/proj-a');
  assert.equal(infos['claude:s1']?.branch, 'main');
  assert.equal(infos['claude:missing'], undefined);
  assert.deepEqual(progress.at(-1), [2, 2]);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => collectSessionInfos(sessions, {}, cfg, { signal: aborted.signal }), ExportCancelledError);
});

test('buildOfflineSnapshot and renderOfflineHtml preserve multi-month, legacy, rates, fixed now, CSP, and safe JSON', async () => {
  const root = await temporaryDirectory('offline-snap-');
  const claudeDir = path.join(root, 'claude');
  const projDir = path.join(claudeDir, 'projects', 'p');
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(
    path.join(projDir, 'cross.jsonl'),
    JSON.stringify({ type: 'user', cwd: '/repo/</script><img src=x onerror=1>', gitBranch: 'feat', message: { content: 'Prompt </script><script>window.xss=1</script>' } }) + '\n',
  );

  const days: Record<string, DayRecord> = {
    '2026-10-15': { claude: { 'claude-sonnet-5-5': bucket(2, 1e6, 5e5) } },
    '2026-11-22': { claude: { 'claude-sonnet-5-5': bucket(3, 2e6, 1e6) }, codex: { 'gpt-5.5': bucket(1, 5e5, 2e5) } },
  };
  const sessions: Record<string, SessionRecord> = {
    'claude:cross': {
      source: 'claude',
      id: 'cross',
      title: 'Cross </script>',
      project: 'p',
      first: Date.parse('2026-10-15T10:00:00Z'),
      last: NOW - 60_000,
      days: {
        '2026-10-15': { 'claude-sonnet-5-5': bucket(2, 1e6, 5e5) },
        '2026-11-22': { 'claude-sonnet-5-5': bucket(1, 1e6, 5e5) },
      },
    },
  };
  for (let i = 0; i < 18; i++) {
    sessions[`codex:s${i}`] = {
      source: 'codex',
      id: `s${i}`,
      project: `proj-${i}`,
      first: NOW - (i + 2) * 3_600_000,
      last: NOW - (i + 1) * 60_000,
      days: { '2026-11-22': { 'gpt-5.5': bucket(1, 1e5, 5e4) } },
    };
  }

  const cfg = normalizeConfig({
    dashboardTheme: 'auto',
    timeZone: 'SGT',
    budgetMode: 'cost',
    budgetLimit: 100,
    correctionFactor: 1.5,
    rates: { 'claude/claude-sonnet-5-5': { input: 4, output: 20 } },
    claudeHome: claudeDir,
    codexHome: path.join(root, 'codex'),
    antigravityHome: path.join(root, 'agy'),
    dshHome: path.join(root, 'dsh'),
  });

  const legacy = { days: { '2026-09-05': { claude: { 'claude-sonnet-5-5': bucket(1, 1e6, 0) } } }, before: Date.parse('2026-09-06T00:00:00Z') };
  const snapshot = await buildOfflineSnapshot(
    {
      days,
      sessions,
      firstDay: '2026-09-05',
      legacy,
      health: { root: '/store', attemptedAt: new Date(NOW).toISOString(), succeededAt: new Date(NOW).toISOString(), problems: ['partial read'] },
      sourceHealth: { claude: { root: claudeDir, status: 'incomplete', attemptedAt: new Date(NOW).toISOString(), problems: ['partial read'] } },
      files: { [path.join(projDir, 'cross.jsonl')]: { size: 10, offset: 10, mtimeMs: NOW - 10_000, source: 'claude', session: 'cross' } },
    },
    cfg,
    { pluginVersion: '1.3.0', now: NOW, resolvedTheme: 'dark' },
  );

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.pluginVersion, '1.3.0');
  assert.equal(snapshot.now, NOW);
  assert.equal(snapshot.config.dashboardTheme, 'dark');
  assert.equal(snapshot.config.correctionFactor, 1.5);
  assert.ok(snapshot.data.active.includes('claude:cross'));
  assert.ok(snapshot.sessionInfos['claude:cross']?.firstPrompt?.includes('</script>'));

  const html = renderOfflineHtml(snapshot, getOfflineBundle());
  assert.match(html, /<body class="theme-dark">/);
  assert.match(html, /Offline snapshot · exported 2026-11-22 12:00 UTC/);
  assert.match(html, /Incomplete scan: some usage may be missing/);
  assert.doesNotMatch(html, /<\/script><script>window\.xss=1/);

  // Verify CSP hash matches the exact inline executable script.
  const { document } = parseHTML(html);
  assert.equal(document.querySelector('[data-action="configure-rates"]'), null);
  assert.equal(document.querySelector('[data-action="open-log"]'), null);
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '';
  const execScript = [...document.querySelectorAll('script')].find((s) => !s.hasAttribute('type'))?.textContent ?? '';
  const hash = createHash('sha256').update(execScript).digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${hash}'`));
  assert.ok(csp.includes("default-src 'none'"));

  // Same usage/cost numbers as extension mode for the same snapshot and fixed `now`.
  const pricing = new Pricing(cfg.rates, cfg.correctionFactor);
  const extSummary = summarize({ days, sessions, firstDay: '2026-09-05', legacy, active: new Set(snapshot.data.active) }, pricing, NOW);
  const extBody = renderBody(extSummary, { ...cfg, dashboardTheme: 'dark' });
  const offDoc = parseHTML(html);
  const extDoc = parseHTML(extBody);
  assert.equal(offDoc.document.querySelector('.hero-figure')?.textContent, extDoc.document.querySelector('.hero-figure')?.textContent);
  assert.equal(offDoc.document.querySelector('.pie-total')?.textContent, extDoc.document.querySelector('.pie-total')?.textContent);
  assert.equal(offDoc.document.querySelector('.scard.total .cost')?.textContent, extDoc.document.querySelector('.scard.total .cost')?.textContent);
});
