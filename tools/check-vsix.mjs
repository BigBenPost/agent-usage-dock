#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

/**
 * Checks a packaged VSIX: `node tools/check-vsix.mjs [file.vsix] [--project DIRECTORY]`. The default file is
 * agent-usage-dock-<version>.vsix in the project. `unzip -t` only proves the archive opens; this proves it is the right package:
 * the exact file list, every entry's CRC-32, the manifest, the readme and changelog, the bundles' version stamp and the icon.
 */
const EXPECTED_FILES = [
  '[Content_Types].xml',
  'extension.vsixmanifest',
  'extension/changelog.md',
  'extension/dist/cli.js',
  'extension/dist/dshWorker.js',
  'extension/dist/extension.js',
  'extension/dist/offline.js',
  'extension/dist/usageWorker.js',
  'extension/LICENSE.txt',
  'extension/media/gemini.svg',
  'extension/media/gemini.woff',
  'extension/media/icon.png',
  'extension/package.json',
  'extension/readme.md',
];
const BUNDLES = ['extension/dist/usageWorker.js', 'extension/dist/cli.js', 'extension/dist/dshWorker.js', 'extension/dist/extension.js'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Entries of a ZIP file, read from its central directory: name to { data, problem }. ZIP64 is not needed for an extension. */
function readZip(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end === -1) throw new Error('not a ZIP file: no end-of-central-directory record');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${i}`);
    const method = buffer.readUInt16LE(at + 10), crc = buffer.readUInt32LE(at + 16), compressed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24), nameLength = buffer.readUInt16LE(at + 28), extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    let data, problem;
    try {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const raw = buffer.subarray(start, start + compressed);
      if (method === 0) data = raw;
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`unsupported compression method ${method}`);
      if (data.length !== size) problem = `size ${data.length} does not match the recorded ${size}`;
      else if (crc32(data) !== crc) problem = 'CRC-32 does not match';
    } catch (error) {
      problem = error.message;
    }
    entries.set(name, { data, problem });
  }
  return entries;
}

/** Returns the list of problems with a VSIX; empty when it is as expected. */
function checkVsix(buffer, project) {
  const problems = [];
  const read = (file) => readFileSync(path.join(project, file));
  const manifest = JSON.parse(read('package.json').toString('utf8'));
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    return [error.message];
  }

  for (const [name, { problem }] of entries) if (problem) problems.push(`${name}: ${problem}`);
  const names = [...entries.keys()].filter((name) => !name.endsWith('/'));
  for (const name of EXPECTED_FILES) if (!names.includes(name)) problems.push(`missing from the package: ${name}`);
  for (const name of names) if (!EXPECTED_FILES.includes(name)) problems.push(`unexpected in the package: ${name}`);

  const text = (name) => entries.get(name)?.data?.toString('utf8');
  const identity = /<Identity\b[^>]*>/.exec(text('extension.vsixmanifest') ?? '')?.[0] ?? '';
  const attribute = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(identity)?.[1];
  if (attribute('Id') !== manifest.name) problems.push(`the manifest Id is ${attribute('Id')}, expected ${manifest.name}`);
  if (attribute('Version') !== manifest.version) problems.push(`the manifest Version is ${attribute('Version')}, expected ${manifest.version}`);
  if (attribute('Publisher') !== manifest.publisher) problems.push(`the manifest Publisher is ${attribute('Publisher')}, expected ${manifest.publisher}`);

  const packaged = text('extension/package.json');
  if (packaged !== undefined && JSON.stringify(JSON.parse(packaged)) !== JSON.stringify(manifest)) problems.push('extension/package.json differs from package.json');
  for (const [inside, outside] of [['extension/readme.md', 'README.md'], ['extension/changelog.md', 'CHANGELOG.md']]) {
    const data = entries.get(inside)?.data;
    if (data && !data.equals(read(outside))) problems.push(`${inside} differs from ${outside}`);
  }

  for (const name of BUNDLES) {
    const bundle = text(name);
    if (bundle === undefined) continue;
    if (!bundle.startsWith(`// agent-usage-dock ${manifest.version}\n`)) problems.push(`${name} does not start with the version stamp for ${manifest.version}`);
    if (/^\/\/# sourceMappingURL=/m.test(bundle)) problems.push(`${name} points at a source map that the package does not ship`);
    if (bundle.includes('__DOCK_BUNDLE_VERSION__')) problems.push(`${name} still contains the unreplaced __DOCK_BUNDLE_VERSION__`);
  }

  const referenced = [manifest.main, manifest.icon, ...Object.values(manifest.contributes?.icons ?? {}).map((icon) => icon.default?.fontPath)];
  for (const file of referenced) {
    if (!file) continue;
    const inside = `extension/${file.replace(/^\.\//, '')}`;
    const withExtension = names.includes(inside) ? inside : `${inside}.js`;
    if (!names.includes(withExtension)) problems.push(`package.json refers to ${file}, which is not in the package`);
  }

  const icon = entries.get('extension/media/icon.png')?.data;
  if (icon) {
    if (icon.length < 24 || !icon.subarray(0, 8).equals(PNG_SIGNATURE)) problems.push('extension/media/icon.png is not a PNG file');
    else if (icon.readUInt32BE(16) !== icon.readUInt32BE(20)) problems.push(`extension/media/icon.png is ${icon.readUInt32BE(16)}x${icon.readUInt32BE(20)}, not square`);
    else if (icon.readUInt32BE(16) < 128) problems.push(`extension/media/icon.png is ${icon.readUInt32BE(16)} pixels wide, at least 128 are needed`);
  }
  return problems;
}

function main(argv) {
  const files = [];
  let project = fileURLToPath(new URL('../', import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) project = path.resolve(argv[++i]);
    else if (argv[i].startsWith('-') || files.length) {
      console.error('usage: node tools/check-vsix.mjs [file.vsix] [--project DIRECTORY]');
      return 2;
    } else files.push(argv[i]);
  }
  const { name, version } = JSON.parse(readFileSync(path.join(project, 'package.json'), 'utf8'));
  const file = path.resolve(files[0] ?? path.join(project, `${name}-${version}.vsix`));
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    console.error(`check-vsix: cannot read ${file}: ${error.message}`);
    return 1;
  }
  const problems = checkVsix(buffer, project);
  if (problems.length) {
    for (const problem of problems) console.error(`check-vsix: ${problem}`);
    return 1;
  }
  console.log(`VSIX OK: ${path.basename(file)}, ${EXPECTED_FILES.length} files, ${(buffer.length / 1024).toFixed(1)} KB, version ${version}.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
