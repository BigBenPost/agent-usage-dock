/**
 * Render the dashboard with rich mock data for README hero screenshots.
 * Outputs JSON with { light, dark } full-page HTML strings.
 *
 * Usage: node tools/render-hero-screenshots.js
 */
const { renderPage, renderBody } = require('../out/src/panelHtml');
const { aggregate } = require('../out/src/reconcile');
const { summarize } = require('../out/src/summary');
const { Pricing } = require('../out/src/pricing');
const { normalizeConfig } = require('../out/src/configValues');

const NOW = Date.parse('2026-11-25T08:00:00Z');
const MONTH = '2026-11';

// Realistic multi-source, multi-model data across the month
const models = [
  { name: 'claude-3.5-sonnet', source: 'claude', inputRate: 3, outputRate: 15 },
  { name: 'claude-3.5-haiku', source: 'claude', inputRate: 0.25, outputRate: 1.25 },
  { name: 'gemini-2.5-pro', source: 'antigravity', inputRate: 1.25, outputRate: 10 },
  { name: 'gemini-2.5-flash', source: 'antigravity', inputRate: 0.15, outputRate: 0.6 },
  { name: 'gpt-4.1', source: 'codex', inputRate: 2, outputRate: 8 },
  { name: 'deepseek-r1', source: 'dsh', inputRate: 0.14, outputRate: 2.19 },
  { name: 'claude-4-opus', source: 'claude', inputRate: 15, outputRate: 75 },
  { name: 'gemini-2.5-flash-lite', source: 'antigravity', inputRate: 0.075, outputRate: 0.3 },
];

const rates = {};
for (const m of models) {
  rates[m.name] = { input: m.inputRate, output: m.outputRate };
}

// Generate realistic daily usage across the month
const records = {};
let recordId = 0;
const sessionIds = {};

for (let day = 1; day <= 25; day++) {
  const dayStr = `${MONTH}-${String(day).padStart(2, '0')}`;
  const isWeekday = new Date(`${dayStr}T12:00:00Z`).getDay() % 6 !== 0;

  // Variable daily intensity
  const intensity = isWeekday ? 0.7 + Math.random() * 0.6 : 0.2 + Math.random() * 0.4;

  for (const model of models) {
    // Not all models used every day
    if (Math.random() > intensity) continue;

    const sessKey = `${model.source}:${model.name}-${day}`;
    if (!sessionIds[sessKey]) sessionIds[sessKey] = `sess-${model.source}-${day}-${recordId}`;

    const baseInput = Math.floor((50000 + Math.random() * 400000) * intensity);
    const baseCacheRead = Math.floor(baseInput * (0.3 + Math.random() * 0.5));
    const baseCacheWrite = Math.floor(baseInput * (0.05 + Math.random() * 0.15));
    const baseOutput = Math.floor((10000 + Math.random() * 100000) * intensity);

    // Create 1-4 requests per model per day
    const reqCount = Math.ceil(Math.random() * 4 * intensity);
    for (let r = 0; r < reqCount; r++) {
      const id = `r${recordId++}`;
      records[id] = {
        id,
        source: model.source,
        day: dayStr,
        model: model.name,
        session: sessionIds[sessKey],
        ts: NOW - (25 - day) * 86400000 + r * 3600000 + Math.floor(Math.random() * 3600000),
        tokens: {
          input: Math.floor(baseInput / reqCount + Math.random() * 20000),
          output: Math.floor(baseOutput / reqCount + Math.random() * 10000),
          cacheRead: Math.floor(baseCacheRead / reqCount),
          cacheWrite: Math.floor(baseCacheWrite / reqCount),
          cacheWrite1h: 0,
        },
        project: ['Workspace', 'Learning', 'Writing', 'Personal'][Math.floor(Math.random() * 4)],
        title: ['Refactor auth flow', 'Debug build pipeline', 'Write unit tests', 'Code review',
                'API design', 'Dashboard polish', 'Fix memory leak', 'Migrate database',
                'Setup CI/CD', 'Optimize queries'][Math.floor(Math.random() * 10)],
      };
    }
  }
}

const facts = aggregate(records);
const pricing = new Pricing(rates);

// Render both themes
const cfgLight = normalizeConfig({
  budgetLimit: 150,
  budgetMode: 'cost',
  dashboardTheme: 'light',
  warningThreshold: 0.75,
  criticalThreshold: 0.9,
});
const cfgDark = normalizeConfig({
  budgetLimit: 150,
  budgetMode: 'cost',
  dashboardTheme: 'dark',
  warningThreshold: 0.75,
  criticalThreshold: 0.9,
});

const summaryLight = summarize(facts, pricing, NOW);
const summaryDark = summarize(facts, pricing, NOW);

// Strip CSP to allow Playwright to work
const stripCSP = (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '');

const lightPage = stripCSP(renderPage(summaryLight, cfgLight));
const darkPage = stripCSP(renderPage(summaryDark, cfgDark));

process.stdout.write(JSON.stringify({ light: lightPage, dark: darkPage }));
