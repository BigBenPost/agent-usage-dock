import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Compiled tests resolve this before dist/offline.js. Always build from source so a
// clean checkout and a checkout with stale release bundles exercise the same code.
await build({
  entryPoints: [fileURLToPath(new URL('../src/offlineApp.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../out/src/offline.js', import.meta.url)),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
});
