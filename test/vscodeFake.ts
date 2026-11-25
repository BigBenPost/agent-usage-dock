import * as fs from 'node:fs';
import * as path from 'node:path';
import { installVscode } from './vscodeStub';

type Handler = (...args: unknown[]) => unknown;
export interface Disposable { dispose(): void }

export class FakeUri {
  constructor(readonly fsPath: string, readonly scheme = 'file') {}
  get path(): string { return this.fsPath; }
  toString(): string { return `${this.scheme}://${this.fsPath}`; }
}

export class FakeStatusBarItem {
  name?: string;
  text = '';
  tooltip?: unknown;
  command?: unknown;
  accessibilityInformation?: unknown;
  backgroundColor?: unknown;
  color?: unknown;
  shown = false;
  disposed = false;
  constructor(readonly alignment: number, readonly priority?: number) {}
  show(): void { this.shown = true; }
  hide(): void { this.shown = false; }
  dispose(): void { this.disposed = true; this.shown = false; }
}

export class FakeOutputChannel {
  readonly lines: string[] = [];
  shown = 0;
  constructor(readonly name: string) {}
  appendLine(line: string): void { this.lines.push(line); }
  append(text: string): void { this.lines.push(text); }
  show(): void { this.shown++; }
  hide(): void {}
  clear(): void { this.lines.length = 0; }
  dispose(): void {}
  get text(): string { return this.lines.join('\n'); }
}

export class FakePanel {
  visible = true;
  iconPath?: unknown;
  disposed = false;
  readonly posts: any[] = [];
  readonly webview = {
    html: '',
    postMessage: (message: unknown): Promise<boolean> => { this.posts.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: Handler): Disposable => { this.received = handler; return { dispose() {} }; },
  };
  private received?: Handler;
  private readonly disposeHandlers: Handler[] = [];
  private readonly viewHandlers: Handler[] = [];
  constructor(readonly viewType: string, readonly title: string, readonly options: unknown) {}
  onDidDispose(handler: Handler): Disposable { this.disposeHandlers.push(handler); return { dispose() {} }; }
  onDidChangeViewState(handler: Handler): Disposable { this.viewHandlers.push(handler); return { dispose() {} }; }
  reveal(): void {}
  dispose(): void { this.disposed = true; this.disposeHandlers.forEach(handler => handler()); }
  /** A message from the page, as `webview.postMessage` in the browser would deliver it. */
  send(message: unknown): void { this.received?.(message); }
  posted(type: string): any[] { return this.posts.filter(post => post?.type === type); }
}

class MarkdownString {
  isTrusted?: unknown;
  supportHtml?: boolean;
  supportThemeIcons?: boolean;
  constructor(public value = '') {}
}

class ThemeColor { constructor(readonly id: string) {} }

export interface WarningRecord { message: string; items: string[]; modal: boolean }

/**
 * An in-memory stand-in for the parts of `vscode` the extension touches. One instance serves a whole test file, because the
 * modules that import `vscode` keep what they got the first time; `reset()` returns it to a clean state between tests.
 */
export class FakeVscode {
  readonly api: Record<string, any>;
  readonly defaults: Record<string, unknown>;
  user: Record<string, Record<string, unknown>> = {};
  workspaceValues: Record<string, Record<string, unknown>> = {};
  commands = new Map<string, Handler>();
  channels: FakeOutputChannel[] = [];
  items: FakeStatusBarItem[] = [];
  panels: FakePanel[] = [];
  warnings: WarningRecord[] = [];
  infos: string[] = [];
  inputs: { title?: string; prompt?: string; value?: string }[] = [];
  quickPicks: { title?: string; labels: string[] }[] = [];
  external: string[] = [];
  documents: string[] = [];
  updates: { section: string; key: string; value: unknown; target: unknown }[] = [];
  changeListeners: Handler[] = [];
  themeListeners: Handler[] = [];
  warningAnswers: (string | undefined)[] = [];
  inputAnswers: (string | undefined)[] = [];
  quickPickAnswers: ((labels: any[]) => unknown)[] = [];
  saveTo?: string;
  colorThemeKind = 1;

  constructor(packageJson: string) {
    const properties = JSON.parse(fs.readFileSync(packageJson, 'utf8')).contributes.configuration.properties as Record<string, { default?: unknown }>;
    this.defaults = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key.replace(/^agyTokenTracker\./, ''), value.default]));
    this.api = this.build();
  }

  get channel(): FakeOutputChannel { return this.channels[this.channels.length - 1]; }
  get statusBarItem(): FakeStatusBarItem { return this.items[this.items.length - 1]; }
  get log(): string { return this.channels.map(channel => channel.text).join('\n'); }

  reset(): void {
    this.user = {};
    this.workspaceValues = {};
    this.commands.clear();
    for (const list of [this.channels, this.items, this.panels, this.warnings, this.infos, this.inputs, this.quickPicks, this.external, this.documents, this.updates, this.changeListeners, this.themeListeners, this.warningAnswers, this.inputAnswers, this.quickPickAnswers] as unknown[][]) list.length = 0;
    this.saveTo = undefined;
    this.colorThemeKind = 1;
  }

  /** Changes a user setting the way the settings editor does: the value is stored, then every listener hears of it. */
  async setSetting(key: string, value: unknown, section = 'agyTokenTracker'): Promise<void> {
    (this.user[section] ??= {})[key] = value;
    await this.announce(section);
  }

  async announce(section: string): Promise<void> {
    const event = { affectsConfiguration: (name: string) => name === section || name.startsWith(section + '.') };
    for (const listener of [...this.changeListeners]) listener(event);
    await new Promise(resolve => setImmediate(resolve));
  }

  private configuration(section: string) {
    const stored = () => (this.user[section] ??= {});
    const defaultOf = (key: string) => (section === 'agyTokenTracker' ? this.defaults[key] : undefined);
    return {
      get: (key: string) => stored()[key] ?? defaultOf(key),
      inspect: (key: string) => ({ key, defaultValue: defaultOf(key), globalValue: stored()[key], workspaceValue: this.workspaceValues[section]?.[key] }),
      update: async (key: string, value: unknown, target?: unknown) => {
        this.updates.push({ section, key, value, target });
        if (value === undefined) delete stored()[key]; else stored()[key] = value;
        await this.announce(section);
      },
    };
  }

  private answer<T>(queue: T[]): T | undefined { return queue.length ? queue.shift() : undefined; }

  private build(): Record<string, any> {
    const fake = this;
    const base = {
      __esModule: true,
      window: {
        createOutputChannel: (name: string) => { const channel = new FakeOutputChannel(name); fake.channels.push(channel); return channel; },
        createStatusBarItem: (alignment: number, priority?: number) => { const item = new FakeStatusBarItem(alignment, priority); fake.items.push(item); return item; },
        createWebviewPanel: (viewType: string, title: string, _column: unknown, options: unknown) => { const panel = new FakePanel(viewType, title, options); fake.panels.push(panel); return panel; },
        showWarningMessage: async (message: string, ...rest: unknown[]) => {
          const modal = rest.some(item => !!item && typeof item === 'object' && (item as { modal?: boolean }).modal === true);
          fake.warnings.push({ message, items: rest.filter((item): item is string => typeof item === 'string'), modal });
          return fake.answer(fake.warningAnswers);
        },
        showInformationMessage: async (message: string) => { fake.infos.push(message); },
        showErrorMessage: async (message: string) => { fake.warnings.push({ message, items: [], modal: false }); },
        withProgress: async <T>(
          _options: unknown,
          task: (progress: { report(v: unknown): void }, token: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => { dispose(): void } }) => Promise<T>,
        ) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }),
        showInputBox: async (options: { title?: string; prompt?: string; value?: string }) => { fake.inputs.push({ title: options.title, prompt: options.prompt, value: options.value }); return fake.answer(fake.inputAnswers); },
        showQuickPick: async (choices: { label: string }[], options: { title?: string }) => {
          fake.quickPicks.push({ title: options?.title, labels: choices.map(choice => choice.label) });
          const pick = fake.answer(fake.quickPickAnswers);
          return pick ? pick(choices) : choices[0];
        },
        showSaveDialog: async () => (fake.saveTo ? new FakeUri(fake.saveTo) : undefined),
        showTextDocument: async (uri: FakeUri) => { fake.documents.push(uri.fsPath); },
        onDidChangeActiveColorTheme: (listener: Handler) => { fake.themeListeners.push(listener); return { dispose: () => { fake.themeListeners.splice(fake.themeListeners.indexOf(listener), 1); } }; },
        get activeColorTheme() { return { kind: fake.colorThemeKind }; },
      },
      workspace: {
        getConfiguration: (section: string) => fake.configuration(section),
        onDidChangeConfiguration: (listener: Handler) => { fake.changeListeners.push(listener); return { dispose: () => { fake.changeListeners.splice(fake.changeListeners.indexOf(listener), 1); } }; },
        fs: { writeFile: async (uri: FakeUri, bytes: Uint8Array) => fs.promises.writeFile(uri.fsPath, bytes) },
      },
      commands: {
        registerCommand: (id: string, handler: Handler) => {
          if (fake.commands.has(id)) throw new Error(`command '${id}' already exists`);
          fake.commands.set(id, handler);
          return { dispose: () => { if (fake.commands.get(id) === handler) fake.commands.delete(id); } };
        },
      },
      env: { openExternal: async (uri: FakeUri) => { fake.external.push(uri.fsPath); return true; } },
      Uri: { file: (target: string) => new FakeUri(target), joinPath: (uri: FakeUri, ...parts: string[]) => new FakeUri(path.join(uri.fsPath, ...parts)) },
      ViewColumn: { Active: -1, Beside: -2 },
      StatusBarAlignment: { Left: 1, Right: 2 },
      ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
      ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
      ProgressLocation: { Notification: 15 },
      MarkdownString,
      ThemeColor,
    };
    const generic = new Map<string, unknown>();
    // Classes and enums the extension starts using later still construct; calls into windows or workspaces it was not given still fail loudly.
    return new Proxy(base, {
      get: (target, name) => {
        if (typeof name === 'string' && !(name in target) && /^[A-Z]/.test(name)) {
          if (!generic.has(name)) generic.set(name, class { constructor(...args: unknown[]) { Object.assign(this, { args }); } });
          return generic.get(name);
        }
        return Reflect.get(target, name);
      },
    });
  }
}

let installed: FakeVscode | undefined;

/** Makes `require('vscode')` return the fake. Call once per test file, before anything under `src/` that imports `vscode` is loaded. */
export function installFakeVscode(): FakeVscode {
  if (!installed) {
    installed = new FakeVscode(path.join(__dirname, '..', '..', 'package.json'));
    installVscode(installed.api);
  }
  return installed;
}

export interface CapturedTimers {
  /** Intervals of 15 seconds or more, which is what the extension's poll timer is. Shorter ones, such as lock heartbeats, run for real. */
  timers: { callback: () => void; ms: number; cleared: boolean }[];
  restore(): void;
}

export function captureIntervals(): CapturedTimers {
  const realSet = global.setInterval, realClear = global.clearInterval;
  const timers: CapturedTimers['timers'] = [];
  const handles = new Map<unknown, CapturedTimers['timers'][number]>();
  (global as any).setInterval = (callback: () => void, ms?: number, ...args: unknown[]) => {
    if ((ms ?? 0) < 15_000) return (realSet as (...all: unknown[]) => NodeJS.Timeout)(callback, ms, ...args);
    const timer = { callback, ms: ms as number, cleared: false };
    const handle = { unref() { return handle; }, ref() { return handle; }, hasRef: () => false };
    timers.push(timer);
    handles.set(handle, timer);
    return handle;
  };
  (global as any).clearInterval = (handle: unknown) => {
    const timer = handles.get(handle);
    if (timer) timer.cleared = true; else realClear(handle as NodeJS.Timeout);
  };
  return { timers, restore: () => { global.setInterval = realSet; global.clearInterval = realClear; } };
}
