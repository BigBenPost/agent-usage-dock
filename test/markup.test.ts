import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attr, esc, markdownText, plain, text, untrusted } from '../src/markup';

test('esc turns each of & < > " \' into a numeric entity, and leaves everything else alone', () => {
  assert.equal(esc('&'), '&#38;');
  assert.equal(esc('<'), '&#60;');
  assert.equal(esc('>'), '&#62;');
  assert.equal(esc('"'), '&#34;');
  assert.equal(esc("'"), '&#39;');
  assert.equal(esc(`a"b'c<d>e&f`), 'a&#34;b&#39;c&#60;d&#62;e&#38;f');
  assert.equal(esc('plain text / 100% [x](y) `z` \\ ; = #'), 'plain text / 100% [x](y) `z` \\ ; = #');
  assert.equal(esc('&#60;'), '&#38;#60;', 'an entity in the input is not read as one');
});

test('esc output cannot close an attribute of either quote style, or open a tag', () => {
  for (const hostile of ['" onmouseover="alert(1)', "' onmouseover='alert(1)", '"><script>alert(1)</script>', "'><img src=x onerror=alert(1)>"]) {
    const out = esc(hostile);
    assert.doesNotMatch(out, /["'<>]/, hostile);
  }
});

test('values that are not strings print as text and never throw', () => {
  assert.equal(esc(5), '5');
  assert.equal(esc(0), '0');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(true), 'true');
  assert.equal(esc({ toString: () => '<b>' }), '&#60;b&#62;');
  assert.equal(esc(['<i>', 2]), '&#60;i&#62;,2');
  assert.equal(esc({ toString() { throw new Error('no'); } }), '');
  assert.equal(esc(Symbol('s')), 'Symbol(s)');
  assert.equal(text(10n), '10');
});

test('plain removes the embedding, override and isolate controls, and only those', () => {
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    assert.equal(plain(`a${String.fromCharCode(code)}b`), 'ab', `U+${code.toString(16)}`);
  }
  for (const code of [0x2029, 0x202f, 0x2065, 0x206a, 0x200e, 0x200f, 0x061c]) {
    assert.equal(plain(`a${String.fromCharCode(code)}b`), `a${String.fromCharCode(code)}b`, `U+${code.toString(16)} is not one of them`);
  }
  assert.equal(plain('invoice\u202egpj.exe'), 'invoicegpj.exe');
  assert.equal(plain(undefined), '');
});

test('untrusted text is stripped, escaped and isolated; attr is the same without the isolation', () => {
  assert.equal(untrusted('a\u202e<b>"'), '<bdi>a&#60;b&#62;&#34;</bdi>');
  assert.equal(attr('a\u202e<b>"'), 'a&#60;b&#62;&#34;');
  assert.equal(untrusted(undefined), '<bdi></bdi>');
});

test('markdownText keeps only characters that cannot start markup or a link, and caps the length', () => {
  assert.equal(markdownText('2026-10-12'), '2026-10-12');
  assert.equal(markdownText('claude-opus-4.6@20260101'), 'claude-opus-4.6@20260101');
  assert.equal(markdownText('a`[b](c)<d>*e*_f_#g!|h~i'), 'abcde_f_ghi');
  assert.equal(markdownText('x'.repeat(100)).length, 60);
  assert.equal(markdownText('x'.repeat(100), 40).length, 40);
  assert.equal(markdownText('\u202eab'), 'ab');
  assert.equal(markdownText(null), '');
  assert.equal(markdownText({ toString() { throw new Error('no'); } }), '');
});
