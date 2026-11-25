import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { AUTHOR_NAME, CONTACT_EMAIL, GEMINI_ICON, LEVEL_BAR_ICONS, LEVEL_RING_ICONS, STATUS_BAR_ICON } from '../src/brand';

const root = path.resolve(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the status bar icon is declared in package.json and its font ships with the extension', () => {
  const id = STATUS_BAR_ICON.slice(2, -1);
  const icon = manifest.contributes.icons[id];
  assert.ok(icon, `contributes.icons has no "${id}"`);
  assert.equal(icon.default.fontCharacter, '\\E900');
  const font = path.join(root, icon.default.fontPath);
  assert.ok(existsSync(font), `${icon.default.fontPath} is missing`);
  assert.equal(readFileSync(font).subarray(0, 4).toString('latin1'), 'wOFF');
});

const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const file = path.join(dir, name);
  return statSync(file).isDirectory() ? sourceFiles(file) : file.endsWith('.ts') ? [file] : [];
});

test('every media file that the code or the manifest points to exists and is what it claims to be, and the packaging keeps media/', () => {
  const referenced = new Map<string, string>();
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/'media',\s*'([^']+)'/g)) referenced.set(match[1], path.relative(root, file));
    for (const match of code.matchAll(/\bmedia\/([\w.-]+\.\w+)/g)) referenced.set(match[1], path.relative(root, file));
  }
  assert.ok(referenced.has('gemini.svg'), 'the dashboard tab icon is media/gemini.svg');
  for (const [name, from] of referenced) assert.ok(existsSync(path.join(root, 'media', name)), `media/${name} (used by ${from}) is missing`);
  assert.match(readFileSync(path.join(root, 'media', 'gemini.svg'), 'utf8'), /^\s*<svg[\s>]/);
  assert.equal(readFileSync(path.join(root, manifest.icon)).subarray(1, 4).toString('latin1'), 'PNG');
  assert.doesNotMatch(readFileSync(path.join(root, '.vscodeignore'), 'utf8'), /^media/m);
});

test('the heading mark is an inline SVG with its own gradient, and nothing in it can run', () => {
  assert.doesNotMatch(GEMINI_ICON, /<script|<style|<image|<foreignObject|\son\w+=|href=|url\((?!#)/i);
  const ids = [...GEMINI_ICON.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  const used = [...GEMINI_ICON.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const id of used) assert.ok(ids.includes(id), `gradient ${id} is not defined`);
});

test('the contact address is one constant, and the manifest and the dashboard header agree with it', () => {
  assert.equal(AUTHOR_NAME, 'zhang.xijue');
  assert.equal(CONTACT_EMAIL, 'zhang.xijue@u.nus.edu');
  assert.equal(manifest.author.name, AUTHOR_NAME);
  assert.equal(manifest.bugs.email, CONTACT_EMAIL);
  assert.equal(manifest.author.email, CONTACT_EMAIL);
  const holders = sourceFiles(path.join(root, 'src')).filter((file) => readFileSync(file, 'utf8').includes(CONTACT_EMAIL));
  assert.deepEqual(holders.map((file) => path.relative(root, file)), [path.join('src', 'brand.ts')]);
});

/** The tables of a WOFF 1 file, uncompressed. */
function woffTables(file: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  for (let i = 0, n = file.readUInt16BE(12); i < n; i++) {
    const at = 44 + i * 20;
    const [offset, compressed, original] = [file.readUInt32BE(at + 4), file.readUInt32BE(at + 8), file.readUInt32BE(at + 12)];
    const raw = file.subarray(offset, offset + compressed);
    tables.set(file.toString('latin1', at, at + 4), compressed < original ? inflateSync(raw) : raw);
  }
  return tables;
}

/** Whether a format 4 cmap subtable maps `codepoint` to a glyph other than .notdef. */
function mapped(cmap: Buffer, codepoint: number): boolean {
  for (let i = 0, n = cmap.readUInt16BE(2); i < n; i++) {
    const offset = cmap.readUInt32BE(8 + i * 8);
    if (cmap.readUInt16BE(offset) !== 4) continue;
    const segments = cmap.readUInt16BE(offset + 6) / 2;
    const ends = offset + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const ranges = deltas + segments * 2;
    for (let s = 0; s < segments; s++) {
      if (codepoint < cmap.readUInt16BE(starts + s * 2) || codepoint > cmap.readUInt16BE(ends + s * 2)) continue;
      const delta = cmap.readInt16BE(deltas + s * 2);
      const range = cmap.readUInt16BE(ranges + s * 2);
      const glyph = range === 0 ? codepoint : cmap.readUInt16BE(ranges + s * 2 + range + 2 * (codepoint - cmap.readUInt16BE(starts + s * 2)));
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
  }
  return false;
}

test('the level glyphs are declared in package.json as glyphs of the same font: rings at U+E902 to E904, bars at U+E905 to E907, each in the order green, amber, red', () => {
  const font = manifest.contributes.icons[STATUS_BAR_ICON.slice(2, -1)].default.fontPath;
  for (const [icons, first] of [[LEVEL_RING_ICONS, 0xe902], [LEVEL_BAR_ICONS, 0xe905]] as const) {
    const declared = Object.values(icons).map((icon) => manifest.contributes.icons[icon.slice(2, -1)]);
    assert.ok(declared.every(Boolean), 'every level glyph is declared in contributes.icons');
    assert.deepEqual(declared.map((d) => d.default.fontPath), [font, font, font]);
    assert.deepEqual(declared.map((d) => d.default.fontCharacter), [0, 1, 2].map((i) => `\\${(first + i).toString(16).toUpperCase()}`));
  }
  assert.deepEqual(Object.keys(manifest.contributes.icons).sort(), [STATUS_BAR_ICON.slice(2, -1), ...Object.values(LEVEL_RING_ICONS), ...Object.values(LEVEL_BAR_ICONS)].map((i) => i.replace(/^\$\(|\)$/g, '')).sort(), 'nothing else is declared');
});

test('the font holds the mark and the six level glyphs, the six as colour glyphs with the three level colours, and nothing else', () => {
  const tables = woffTables(readFileSync(path.join(root, manifest.contributes.icons[STATUS_BAR_ICON.slice(2, -1)].default.fontPath)));
  for (const cp of [0xe900, 0xe902, 0xe903, 0xe904, 0xe905, 0xe906, 0xe907]) assert.equal(mapped(tables.get('cmap')!, cp), true, `U+${cp.toString(16)} is in the font`);
  for (const cp of [0xe901, 0xe908]) assert.equal(mapped(tables.get('cmap')!, cp), false, `U+${cp.toString(16)} is not in the font`);
  const colr = tables.get('COLR')!;
  assert.equal(colr.readUInt16BE(0), 0, 'COLR version 0, which every Chromium draws');
  assert.equal(colr.readUInt16BE(2), 6, 'one colour glyph per level and shape');
  const cpal = tables.get('CPAL')!;
  assert.deepEqual([cpal.readUInt16BE(2), cpal.readUInt16BE(4)], [3, 1], 'three colours in one palette');
  const first = cpal.readUInt32BE(8);
  const hex = (i: number) => [2, 1, 0].map((c) => cpal.readUInt8(first + i * 4 + c).toString(16).padStart(2, '0')).join('');
  assert.deepEqual([0, 1, 2].map(hex), ['3cb35c', 'e89a00', 'e64242']);
});
