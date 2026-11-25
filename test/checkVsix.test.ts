import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { temporaryDirectory } from './temp';

const project = path.resolve(__dirname, '../..');
const checker = path.join(project, 'tools', 'check-vsix.mjs');
const VERSION = '9.9.9';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Record<string, Buffer>, options: { stored?: string[]; damage?: string } = {}): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const stored = options.stored?.includes(name);
    const body = stored ? Buffer.from(data) : deflateRawSync(data);
    if (options.damage === name) body[Math.floor(body.length / 2)] ^= 0xff;
    const label = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(label.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, label, body);
    directory.push(entry, label);
    offset += 30 + label.length + body.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

const MANIFEST = {
  name: 'fake-ext', version: VERSION, publisher: 'someone', main: './dist/extension.js', icon: 'media/icon.png',
  contributes: { icons: { mark: { default: { fontPath: './media/gemini.woff', fontCharacter: '\\E900' } } } },
};
const README = Buffer.from('# Readme\n\nText.\n');
const CHANGELOG = Buffer.from('# Changelog\n\n## 9.9.9\n\n- Something.\n');
const bundle = (name: string) => Buffer.from(`// agent-usage-dock ${VERSION}\n"use strict";\nconsole.log(${JSON.stringify(name)});\n`);

function goodEntries(): Record<string, Buffer> {
  return {
    '[Content_Types].xml': Buffer.from('<Types/>'),
    'extension.vsixmanifest': Buffer.from(`<PackageManifest><Metadata><Identity Language="en-US" Id="fake-ext" Version="${VERSION}" Publisher="someone" /></Metadata></PackageManifest>`),
    'extension/changelog.md': CHANGELOG,
    'extension/dist/cli.js': bundle('cli'),
    'extension/dist/dshWorker.js': bundle('worker'),
    'extension/dist/extension.js': bundle('extension'),
    'extension/dist/offline.js': Buffer.from('(() => {})();\n'),
    'extension/LICENSE.txt': Buffer.from('License'),
    'extension/media/gemini.svg': Buffer.from('<svg/>'),
    'extension/media/gemini.woff': Buffer.from('wOFF'),
    'extension/media/icon.png': png(256, 256),
    'extension/package.json': Buffer.from(JSON.stringify(MANIFEST)),
    'extension/readme.md': README,
  };
}

async function check(entries: Record<string, Buffer> | Buffer, options: Parameters<typeof zip>[1] = {}, extraArgs: string[] = []) {
  const root = await temporaryDirectory('check-vsix-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(root, 'README.md'), README);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  const file = path.join(root, `fake-ext-${VERSION}.vsix`);
  await fs.writeFile(file, Buffer.isBuffer(entries) ? entries : zip(entries, options));
  const run = spawnSync(process.execPath, [checker, ...(extraArgs.length ? extraArgs : [file]), '--project', root], { encoding: 'utf8' });
  assert.equal(run.error, undefined);
  return { ...run, file, root };
}

const without = (name: string) => Object.fromEntries(Object.entries(goodEntries()).filter(([key]) => key !== name));
const changed = (name: string, data: Buffer | string) => ({ ...goodEntries(), [name]: Buffer.from(data) });

test('a package with exactly the expected files passes, whether the entries are deflated or stored', async () => {
  const deflated = await check(goodEntries());
  assert.equal(deflated.status, 0, deflated.stderr);
  assert.match(deflated.stdout, /^VSIX OK: fake-ext-9\.9\.9\.vsix, 13 files/);
  const stored = await check(goodEntries(), { stored: Object.keys(goodEntries()) });
  assert.equal(stored.status, 0, stored.stderr);
});

test('the default file is <name>-<version>.vsix in the project', async () => {
  const root = await temporaryDirectory('check-vsix-default-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(MANIFEST));
  await fs.writeFile(path.join(root, 'README.md'), README);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  const missing = spawnSync(process.execPath, [checker, '--project', root], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read .*fake-ext-9\.9\.9\.vsix/);
  await fs.writeFile(path.join(root, `fake-ext-${VERSION}.vsix`), zip(goodEntries()));
  const found = spawnSync(process.execPath, [checker, '--project', root], { encoding: 'utf8' });
  assert.equal(found.status, 0, found.stderr);
});

test('a package without the DSH worker fails, which unzip -t does not notice', async () => {
  const result = await check(without('extension/dist/dshWorker.js'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing from the package: extension\/dist\/dshWorker\.js/);
});

test('files that do not belong in the package are named', async () => {
  for (const stray of ['extension/dist/extension.js.map', 'extension/src/store.ts', 'extension/README.md']) {
    const result = await check({ ...goodEntries(), [stray]: Buffer.from('x') });
    assert.equal(result.status, 1, stray);
    assert.match(result.stderr, new RegExp(`unexpected in the package: ${stray.replace(/[.\\/]/g, '\\$&')}`));
  }
});

test('a damaged entry fails its CRC-32, and a file that is not a ZIP is reported', async () => {
  const damaged = await check(goodEntries(), { stored: ['extension/dist/cli.js'], damage: 'extension/dist/cli.js' });
  assert.equal(damaged.status, 1);
  assert.match(damaged.stderr, /extension\/dist\/cli\.js: CRC-32 does not match/);
  const text = await check(Buffer.from('not a zip file at all, but long enough to scan for a directory record'));
  assert.equal(text.status, 1);
  assert.match(text.stderr, /not a ZIP file/);
});

test('the manifest, readme and changelog must match the project', async () => {
  const wrongVersion = await check(changed('extension.vsixmanifest', '<Identity Id="fake-ext" Version="1.0.0" Publisher="someone" />'));
  assert.match(wrongVersion.stderr, /manifest Version is 1\.0\.0, expected 9\.9\.9/);
  const wrongPublisher = await check(changed('extension.vsixmanifest', `<Identity Id="fake-ext" Version="${VERSION}" Publisher="other" />`));
  assert.match(wrongPublisher.stderr, /manifest Publisher is other, expected someone/);
  const oldPackageJson = await check(changed('extension/package.json', JSON.stringify({ ...MANIFEST, license: 'MIT' })));
  assert.match(oldPackageJson.stderr, /extension\/package\.json differs from package\.json/);
  const rewrittenReadme = await check(changed('extension/readme.md', '# Readme\n\nText with inlined images.\n'));
  assert.match(rewrittenReadme.stderr, /extension\/readme\.md differs from README\.md/);
  const oldChangelog = await check(changed('extension/changelog.md', '# Changelog\n'));
  assert.match(oldChangelog.stderr, /extension\/changelog\.md differs from CHANGELOG\.md/);
});

test('every bundle carries the version stamp and no dangling source map or build constant', async () => {
  const unstamped = await check(changed('extension/dist/cli.js', '"use strict";\n'));
  assert.match(unstamped.stderr, /extension\/dist\/cli\.js does not start with the version stamp for 9\.9\.9/);
  const staleStamp = await check(changed('extension/dist/extension.js', '// agent-usage-dock 9.9.8\n'));
  assert.match(staleStamp.stderr, /extension\/dist\/extension\.js does not start with the version stamp/);
  const mapped = await check(changed('extension/dist/dshWorker.js', `${bundle('worker')}//# sourceMappingURL=dshWorker.js.map\n`));
  assert.match(mapped.stderr, /extension\/dist\/dshWorker\.js points at a source map that the package does not ship/);
  const constant = await check(changed('extension/dist/cli.js', `${bundle('cli')}const v = __DOCK_BUNDLE_VERSION__;\n`));
  assert.match(constant.stderr, /extension\/dist\/cli\.js still contains the unreplaced __DOCK_BUNDLE_VERSION__/);
});

test('the icon must be a square PNG of at least 128 pixels, and everything the manifest names must be packaged', async () => {
  const flat = await check(changed('extension/media/icon.png', png(255, 256)));
  assert.match(flat.stderr, /icon\.png is 255x256, not square/);
  const small = await check(changed('extension/media/icon.png', png(64, 64)));
  assert.match(small.stderr, /icon\.png is 64 pixels wide, at least 128 are needed/);
  const notPng = await check(changed('extension/media/icon.png', 'GIF89a and some more bytes to be long enough'));
  assert.match(notPng.stderr, /icon\.png is not a PNG file/);
  const entries = goodEntries();
  const root = await temporaryDirectory('check-vsix-manifest-');
  const manifest = { ...MANIFEST, main: './dist/other.js' };
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, 'README.md'), README);
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), CHANGELOG);
  entries['extension/package.json'] = Buffer.from(JSON.stringify(manifest));
  const file = path.join(root, 'x.vsix');
  await fs.writeFile(file, zip(entries));
  const run = spawnSync(process.execPath, [checker, file, '--project', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /package\.json refers to \.\/dist\/other\.js, which is not in the package/);
});

test('bad arguments exit with 2', async () => {
  for (const args of [['--bogus'], ['a.vsix', 'b.vsix']]) {
    const run = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 2, args.join(' '));
    assert.match(run.stderr, /usage: node tools\/check-vsix\.mjs/);
  }
});
