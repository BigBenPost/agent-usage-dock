import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscode } from './vscodeStub';
const current: Record<string, unknown> = {}, legacy: Record<string, unknown> = { tokenBudgetLimit: 50 };
const workspace: Record<string, unknown> = {};
const configuration = (section: string) => ({
  inspect: (key: string) => ({ globalValue: (section === 'agyTokenTracker' ? current : legacy)[key], workspaceValue: workspace[key] }),
  get: () => 0,
});
installVscode({ workspace: { getConfiguration: configuration }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 } });
const { readConfig, settingTarget } = require('../src/config') as typeof import('../src/config');
test('explicit legacy settings survive new manifest defaults and explicit new zero wins', () => {
  assert.equal(readConfig().tokenBudgetLimit, 50);
  current.tokenBudgetLimit = 0;
  assert.equal(readConfig().tokenBudgetLimit, 0);
  delete current.tokenBudgetLimit;
});

test('machine-local settings ignore workspace paths and dashboard edits target effective overrides', () => {
  workspace.timeZone = 'UTC';
  workspace.codexHome = '/workspace-value';
  current.codexHome = '/machine-value';
  assert.equal(readConfig().codexHome, '/machine-value');
  assert.equal(readConfig().timeZone, 'UTC');
  const config = configuration('agyTokenTracker') as never;
  assert.equal(settingTarget(config, 'timeZone'), 2);
  assert.equal(settingTarget(config, 'codexHome'), 1);
});
