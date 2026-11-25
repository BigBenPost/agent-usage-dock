import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from './temp';

const project = path.resolve(__dirname, '../..');
const guard = path.join(project, 'tools', 'net-guard.cjs');

/** Runs `script` as a CommonJS file with the guard preloaded, in a folder of its own. The script prints one JSON value. */
async function runGuarded(script: string): Promise<{ status: number | null; stderr: string; result: Record<string, string> }> {
  const dir = await temporaryDirectory('net-guard-');
  const file = path.join(dir, 'fixture.cjs');
  await fs.writeFile(file, script);
  const run = spawnSync(process.execPath, ['--require', guard, file], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.error, undefined);
  return { status: run.status, stderr: run.stderr, result: run.stdout.trim() ? JSON.parse(run.stdout) : {} };
}

const ATTEMPT = `
const attempt = (fn) => new Promise((resolve) => {
  let handle;
  try { handle = fn(); } catch (error) { return resolve(error.code ?? error.message); }
  if (handle && typeof handle.once === 'function') handle.once('error', (error) => resolve(error.code ?? error.message));
  setImmediate(() => { handle?.destroy?.(); resolve('allowed'); });
});
const settle = async (table) => Object.fromEntries(await Promise.all(Object.entries(table).map(async ([name, fn]) => [name, await fn()])));
`;

test('connections to non-loopback addresses and names are rejected with ERR_NET_GUARD', async () => {
  const { result, stderr, status } = await runGuarded(`
const net = require('node:net'), http = require('node:http'), https = require('node:https'), tls = require('node:tls');
${ATTEMPT}
(async () => {
  const outcome = await settle({
    tcpOptions: () => attempt(() => net.connect({ host: '192.0.2.1', port: 9 })),
    tcpPortHost: () => attempt(() => net.connect(9, '192.0.2.1')),
    tcpName: () => attempt(() => net.connect(80, 'example.com')),
    tcpIpv6: () => attempt(() => net.connect({ host: '2001:db8::1', port: 9 })),
    socketConnect: () => attempt(() => new net.Socket().connect({ host: 'example.com', port: 80 })),
    http: () => attempt(() => http.get('http://example.com/')),
    https: () => attempt(() => https.get('https://example.com/')),
    tls: () => attempt(() => tls.connect({ host: 'example.com', port: 443 })),
    fetch: () => fetch('http://192.0.2.1:8080/', { signal: AbortSignal.timeout(3000) }).then(() => 'allowed', (error) => error.cause?.code ?? error.code ?? error.name),
  });
  console.log(JSON.stringify(outcome));
})();
`);
  assert.deepEqual(Object.values(result), Object.keys(result).map(() => 'ERR_NET_GUARD'), JSON.stringify(result));
  assert.equal(Object.keys(result).length, 9);
  assert.equal(status, 1);
  assert.match(stderr, /net-guard: network access to 192\.0\.2\.1:9 is blocked/);
});

test('UDP and DNS lookups of non-loopback hosts are rejected as well', async () => {
  const { result } = await runGuarded(`
const dgram = require('node:dgram'), dns = require('node:dns');
${ATTEMPT}
(async () => {
  const udp = (fn) => () => attempt(() => { const socket = dgram.createSocket('udp4'); socket.on('error', () => {}); try { fn(socket); } finally { socket.close(); } });
  const outcome = await settle({
    udpSend: udp((socket) => socket.send(Buffer.from('x'), 9, '192.0.2.1')),
    udpSendRange: udp((socket) => socket.send(Buffer.from('xx'), 0, 1, 9, '192.0.2.1')),
    udpConnect: udp((socket) => socket.connect(9, '192.0.2.1')),
    lookup: () => attempt(() => dns.lookup('example.com', () => {})),
    resolve4: () => attempt(() => dns.resolve4('example.com', () => {})),
    resolver: () => attempt(() => new dns.Resolver().resolve('example.com', () => {})),
    lookupPromise: () => dns.promises.lookup('example.com').then(() => 'allowed', (error) => error.code),
    resolvePromise: () => new dns.promises.Resolver().resolve4('example.com').then(() => 'allowed', (error) => error.code),
  });
  console.log(JSON.stringify(outcome));
})();
`);
  assert.deepEqual(Object.values(result), Object.keys(result).map(() => 'ERR_NET_GUARD'), JSON.stringify(result));
  assert.equal(Object.keys(result).length, 8);
});

test('loopback addresses, local sockets and address literals are allowed', async () => {
  const { result, status, stderr } = await runGuarded(`
const net = require('node:net'), dns = require('node:dns'), dgram = require('node:dgram');
${ATTEMPT}
const connected = (...args) => new Promise((resolve) => {
  const socket = net.connect(...args);
  socket.once('connect', () => { socket.destroy(); resolve('connected'); });
  socket.once('error', (error) => resolve(error.code));
});
const verdict = (outcome) => (outcome === 'ERR_NET_GUARD' ? 'blocked' : 'allowed');
const notBlocked = async (options) => verdict(await attempt(() => net.connect(options)));
(async () => {
  const tcp = net.createServer((socket) => socket.end());
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const { port } = tcp.address();
  const outcome = {
    loopbackAddress: await connected({ host: '127.0.0.1', port }),
    loopbackPortHost: await connected(port, '127.0.0.1'),
    loopbackSubnet: await notBlocked({ host: '127.1.2.3', port }),
    localhost: await notBlocked({ host: 'localhost', port }),
    subdomainOfLocalhost: await notBlocked({ host: 'dock.localhost', port }),
    ipv6Loopback: await notBlocked({ host: '::1', port }),
    ipv4MappedLoopback: await notBlocked({ host: '::ffff:127.0.0.1', port }),
    lookupLocalhost: verdict(await attempt(() => dns.lookup('localhost', () => {}))),
    lookupLiteral: verdict(await attempt(() => dns.lookup('192.0.2.1', () => {}))),
    udpLoopback: verdict(await attempt(() => { const socket = dgram.createSocket('udp4'); socket.on('error', () => {}); socket.send(Buffer.from('x'), 9, '127.0.0.1', () => socket.close()); return socket; })),
  };
  if (process.platform !== 'win32') {
    const ipc = net.createServer((socket) => socket.end());
    await new Promise((resolve) => ipc.listen('s.sock', resolve));
    outcome.ipcPath = await connected('s.sock');
    outcome.ipcOptions = await connected({ path: 's.sock' });
    ipc.close();
  }
  tcp.close();
  console.log(JSON.stringify(outcome));
})();
`);
  assert.equal(status, 0, stderr);
  const { loopbackAddress, loopbackPortHost, ipcPath, ipcOptions, ...rest } = result;
  assert.deepEqual([loopbackAddress, loopbackPortHost], ['connected', 'connected']);
  if (process.platform !== 'win32') assert.deepEqual([ipcPath, ipcOptions], ['connected', 'connected']);
  assert.deepEqual(Object.values(rest), Object.keys(rest).map(() => 'allowed'), JSON.stringify(rest));
});

test('a violation that the code swallows still fails the process', async () => {
  const { status, stderr } = await runGuarded(`
try { require('node:net').connect(80, 'example.com'); } catch {}
console.log('{}');
`);
  assert.equal(status, 1);
  assert.match(stderr, /net-guard: network access to example\.com:80 is blocked in tests/);
});

test('preloaded through NODE_OPTIONS and again with --require, as the runner does, a violation is reported once', async () => {
  const dir = await temporaryDirectory('net-guard-twice-');
  const file = path.join(dir, 'fixture.cjs');
  await fs.writeFile(file, `
let code;
try { require('node:net').connect(80, 'example.com'); } catch (error) { code = error.code; }
console.log(JSON.stringify({ code }));
`);
  const run = spawnSync(process.execPath, ['--require', guard, file], { env: { ...process.env, NODE_OPTIONS: `--require "${guard.replace(/\\/g, '\\\\')}"` }, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { code: 'ERR_NET_GUARD' });
  assert.equal(run.stderr.match(/net-guard:/g)?.length, 1);
});
