import Module = require('module');

/** Makes `require('vscode')` return `stub`, for the few modules that need the editor. Call before requiring them. */
export function installVscode(stub: object): void {
  const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = loader._load;
  loader._load = function (request, ...rest) {
    return request === 'vscode' ? stub : load.call(this, request, ...rest);
  };
}
