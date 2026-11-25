import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installVscode } from './vscodeStub';

type Scopes = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };
const settings: Record<'agyTokenTracker' | 'agyTokenMonitor', Record<string, Scopes>> = { agyTokenTracker: {}, agyTokenMonitor: {} };
installVscode({
  workspace: {
    getConfiguration: (section: keyof typeof settings) => ({
      inspect: (key: string) => ({ key, ...settings[section][key] }),
      get: (key: string) => settings[section][key]?.globalValue,
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
});
const { readConfig } = require('../src/config') as typeof import('../src/config');

const reset = (): void => { settings.agyTokenTracker = {}; settings.agyTokenMonitor = {}; };
const rates = (section: keyof typeof settings, scopes: Scopes): void => { settings[section].rates = scopes; };

test('a workspace that sets one rate leaves the rest of the rates of the user, as VS Code merges an object setting across scopes', () => {
  reset();
  rates('agyTokenTracker', {
    globalValue: { 'gpt-5.5': { input: 3, output: 20 }, 'claude-opus-5': { input: 4, cacheRead: 0.4 } },
    workspaceValue: { 'gpt-5.5': { input: 1 } },
  });
  assert.deepEqual(readConfig().rates, { 'gpt-5.5': { input: 1, output: 20 }, 'claude-opus-5': { input: 4, cacheRead: 0.4 } });
});

test('the user, then the workspace, then the workspace folder: each overrides the one before it, model by model and field by field', () => {
  reset();
  rates('agyTokenTracker', {
    globalValue: { a: { input: 1, output: 1 }, b: { input: 1 }, c: { input: 1 } },
    workspaceValue: { a: { input: 2 }, b: { output: 2 }, d: { input: 2 } },
    workspaceFolderValue: { a: { input: 3, cacheRead: 3 }, d: { output: 3 } },
  });
  assert.deepEqual(readConfig().rates, { a: { input: 3, output: 1, cacheRead: 3 }, b: { input: 1, output: 2 }, c: { input: 1 }, d: { input: 2, output: 3 } });
});

test('what the scopes hold is not changed, a scope that is not an object is passed over, and a key that names a prototype stays a key', () => {
  reset();
  const user = { a: { input: 1 } };
  const workspace = JSON.parse('{"__proto__": {"polluted": true}, "a": {"output": 2}}') as Record<string, unknown>;
  rates('agyTokenTracker', { globalValue: user, workspaceValue: workspace, workspaceFolderValue: 'not an object' });
  const merged = readConfig().rates;
  assert.deepEqual(merged.a, { input: 1, output: 2 });
  assert.deepEqual(user, { a: { input: 1 } }, 'the object of the user is left as it was');
  assert.equal(Object.getPrototypeOf(merged), Object.prototype);
  assert.equal((merged as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test('the section it was renamed from is read only when the new one has no rates of its own, and its scopes merge the same way', () => {
  reset();
  rates('agyTokenMonitor', { globalValue: { a: { input: 1, output: 1 } }, workspaceValue: { a: { input: 2 } } });
  assert.deepEqual(readConfig().rates, { a: { input: 2, output: 1 } }, 'the old section alone');
  rates('agyTokenTracker', { workspaceValue: { b: { input: 5 } } });
  assert.deepEqual(readConfig().rates, { b: { input: 5 } }, 'one value in the new section is enough to leave the old one unread');
  rates('agyTokenTracker', { workspaceValue: 'oops' });
  assert.deepEqual(readConfig().rates, {}, 'and so is a value that is no use');
  reset();
  assert.deepEqual(readConfig().rates, {}, 'no rates anywhere');
});

test('the other settings keep choosing the scope nearest the work', () => {
  reset();
  settings.agyTokenTracker.timeZone = { globalValue: 'SGT', workspaceValue: 'UTC' };
  settings.agyTokenTracker.budgetLimit = { globalValue: 10, workspaceValue: 20, workspaceFolderValue: 30 };
  settings.agyTokenTracker.codexHome = { globalValue: '/machine', workspaceValue: '/workspace' };
  const config = readConfig();
  assert.equal(config.timeZone, 'UTC');
  assert.equal(config.budgetLimit, 30);
  assert.equal(config.codexHome, '/machine', 'a path on this machine is not taken from the workspace');
});

test('the rates Configure Rates edits are those of the scope it saves to: the folder, else the workspace, else the user, and the old section only while the new one has none', () => {
  const { ownRates } = require('../src/config') as typeof import('../src/config');
  const config = () => ({ inspect: (key: string) => ({ key, ...settings.agyTokenTracker[key] }) }) as never;
  reset();
  rates('agyTokenTracker', { globalValue: { g: { input: 1 } }, workspaceValue: { w: { input: 2 } }, workspaceFolderValue: { f: { input: 3 } } });
  assert.deepEqual(ownRates(config()), { f: { input: 3 } });
  rates('agyTokenTracker', { globalValue: { g: { input: 1 } }, workspaceValue: { w: { input: 2 } } });
  assert.deepEqual(ownRates(config()), { w: { input: 2 } });
  rates('agyTokenTracker', { globalValue: { g: { input: 1 } } });
  assert.deepEqual(ownRates(config()), { g: { input: 1 } });
  reset();
  rates('agyTokenMonitor', { globalValue: { old: { input: 4 } }, workspaceValue: { old: { output: 5 } } });
  assert.deepEqual(ownRates(config()), { old: { input: 4, output: 5 } }, 'what the old section would have given');
  rates('agyTokenTracker', { globalValue: 'oops' });
  assert.deepEqual(ownRates(config()), {}, 'a value of the new section that is no use is still the new section');
  reset();
  assert.deepEqual(ownRates(config()), {});
});

test('rate editing removes only the target scope when computing inheritance', () => {
  const { inheritedRates, ownRates } = require('../src/config') as typeof import('../src/config');
  reset();
  rates('agyTokenTracker', { globalValue: { model: { input: 99, output: 100 } }, workspaceValue: { other: { input: 1 } } });
  const c = { inspect: () => ({ ...settings.agyTokenTracker.rates }) } as never;
  assert.equal(ownRates(c).model, undefined, 'an inherited model is blank in the editor');
  assert.deepEqual(inheritedRates(c, 'model').model, { input: 99, output: 100 });
  rates('agyTokenTracker', { globalValue: { model: { input: 99, output: 100 } }, workspaceValue: { model: { output: 101 } } });
  assert.deepEqual(ownRates(c).model, { output: 101 });
  assert.deepEqual(inheritedRates(c, 'model').model, { input: 99, output: 100 });
});
