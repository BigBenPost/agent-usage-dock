import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeConfig } from '../src/configValues';

test('defaults apply when nothing is set', () => {
  assert.deepEqual(normalizeConfig({}), {
    budgetMode: 'tokens', dashboardTheme: 'light', timeZone: 'SGT', tooltipChart: true, statusBarStyle: 'percent', levelIndicator: 'bar', antigravityHome: '', dshHome: '', dshEnabled: true, antigravityEnabled: true, claudeEnabled: true, codexEnabled: true, claudeHome: '', codexHome: '', tokenBudgetLimit: 0, budgetLimit: 0, warningThreshold: 0.75, criticalThreshold: 0.9,
    pollIntervalSeconds: 60, correctionFactor: 1, rates: {},
  });
});

test('valid values pass through, and the poll interval keeps its 15 second floor', () => {
  const c = normalizeConfig({ dashboardTheme: 'auto', timeZone: 'SGT', tooltipChart: false, statusBarStyle: 'ring', levelIndicator: 'ring', antigravityHome: '/tmp/antigravity', dshHome: '', dshEnabled: true, antigravityEnabled: true, claudeEnabled: true, codexEnabled: true, claudeHome: '~/claude-sample', codexHome: '~/codex-sample', tokenBudgetLimit: 50, budgetLimit: 123.5, warningThreshold: 0.5, criticalThreshold: 0.8, pollIntervalSeconds: 5, correctionFactor: 0.8, rates: { 'gpt-*': { input: 1 } } });
  assert.deepEqual(c, { budgetMode: 'tokens', dashboardTheme: 'auto', timeZone: 'SGT', tooltipChart: false, statusBarStyle: 'ring', levelIndicator: 'ring', antigravityHome: '/tmp/antigravity', dshHome: '', dshEnabled: true, antigravityEnabled: true, claudeEnabled: true, codexEnabled: true, claudeHome: '~/claude-sample', codexHome: '~/codex-sample', tokenBudgetLimit: 50, budgetLimit: 123.5, warningThreshold: 0.5, criticalThreshold: 0.8, pollIntervalSeconds: 15, correctionFactor: 0.8, rates: { 'gpt-*': { input: 1 } } });
  assert.equal(normalizeConfig({ dashboardTheme: 'dark', statusBarStyle: 'gauge' }).dashboardTheme, 'dark');
});

test('wrongly typed or out-of-range values fall back or clamp instead of becoming NaN', () => {
  const c = normalizeConfig({ pollIntervalSeconds: 'x', budgetLimit: '500', warningThreshold: 7, criticalThreshold: -1, correctionFactor: '<b>1</b>', dashboardTheme: 'neon', timeZone: 'Mars/Base', statusBarStyle: 42, tooltipChart: 'no', rates: [1, 2] });
  assert.equal(c.pollIntervalSeconds, 60);
  assert.equal(c.budgetLimit, 0);
  assert.equal(c.warningThreshold, 1);
  assert.equal(c.criticalThreshold, 1);
  assert.equal(c.correctionFactor, 1);
  assert.equal(c.dashboardTheme, 'light');
  assert.equal(c.timeZone, 'SGT');
  assert.equal(c.levelIndicator, 'bar');
  assert.equal(c.statusBarStyle, 'percent');
  assert.equal(c.tooltipChart, true);
  assert.deepEqual(c.rates, {});
  for (const v of [NaN, Infinity, -Infinity, null, undefined]) assert.equal(normalizeConfig({ budgetLimit: v, pollIntervalSeconds: v, correctionFactor: v }).pollIntervalSeconds, 60);
  assert.equal(normalizeConfig({ budgetLimit: -5 }).budgetLimit, 0);
});

test('a poll interval too long for a timer is capped at a day instead of firing every millisecond', () => {
  assert.equal(normalizeConfig({ pollIntervalSeconds: 3e6 }).pollIntervalSeconds, 86_400);
  assert.equal(normalizeConfig({ pollIntervalSeconds: 86_400 }).pollIntervalSeconds, 86_400);
  assert.equal(normalizeConfig({ pollIntervalSeconds: Infinity }).pollIntervalSeconds, 60);
});
