import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const isWatch = args.includes('--watch');
const withSourcemap = isWatch || args.includes('--sourcemap');
const outdirAt = args.indexOf('--outdir');
const unknown = args.filter((arg, i) => !['--watch', '--sourcemap', '--outdir'].includes(arg) && args[i - 1] !== '--outdir');
if (unknown.length || (outdirAt !== -1 && !args[outdirAt + 1])) {
  console.error('usage: node esbuild.mjs [--watch] [--sourcemap] [--outdir DIRECTORY]');
  process.exit(2);
}

const outdir = outdirAt === -1 ? path.join(root, 'dist') : path.resolve(args[outdirAt + 1]);

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  absWorkingDir: root,
  entryPoints: { extension: 'src/extension.ts', cli: 'src/cli.ts', dshWorker: 'src/collectors/dshWorker.ts' },
  bundle: true,
  outdir,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define: { __DOCK_BUNDLE_VERSION__: JSON.stringify(version) },
  // The VSIX does not ship .map files, so a packaged bundle must not point at one: maps are for watch builds and opt-in.
  sourcemap: withSourcemap,
  minify: false,
  // First line of each bundle: lets an extension tell whether the CLI already installed is newer than its own (src/cliInstall.ts).
  banner: { js: `// agent-usage-dock ${version}` },
};

/** @type {import('esbuild').BuildOptions} */
const offlineBuildOptions = {
  absWorkingDir: root,
  entryPoints: { offline: 'src/offlineApp.ts' },
  bundle: true,
  outdir,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  minify: false,
};

if (isWatch) {
  const [ctx, offlineCtx] = await Promise.all([esbuild.context(buildOptions), esbuild.context(offlineBuildOptions)]);
  await Promise.all([ctx.watch(), offlineCtx.watch()]);
  console.log('Watching for changes…');
} else {
  await Promise.all([esbuild.build(buildOptions), esbuild.build(offlineBuildOptions)]);
  console.log('Build complete.');
}
