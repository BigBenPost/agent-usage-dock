'use strict';
// Preloaded into every Node process of the test run (`--require`, and NODE_OPTIONS for children): the extension has no network
// code, so a test that reaches a non-loopback host is a defect. A violation throws, writes to stderr and fails the process.
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');

const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|\[?::ffff:127(?:\.\d{1,3}){3}\]?)$/i;

function violation(target) {
  const error = new Error(`net-guard: network access to ${target} is blocked in tests; only loopback addresses and local sockets are allowed.`);
  error.code = 'ERR_NET_GUARD';
  process.exitCode = 1;
  process.stderr.write(`${error.message}\n`);
  return error;
}

function assertLoopback(host, port) {
  if (typeof host === 'string' && !LOOPBACK.test(host)) throw violation(port === undefined ? host : `${host}:${port}`);
}

/** Host and port of the arguments `Socket.prototype.connect` accepts: (options), (path), (port[, host]), or the normalized [options, callback]. */
function connectTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === 'object') return first.path ? {} : { host: first.host || 'localhost', port: first.port };
  if (typeof first === 'string' && !/^\d+$/.test(first)) return {};
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const { host, port } = connectTarget(args);
  assertLoopback(host, port);
  return connect.apply(this, args);
};

const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (message, ...rest) {
  assertLoopback(rest.find((arg) => typeof arg === 'string'));
  return send.call(this, message, ...rest);
};

const udpConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (port, address, ...rest) {
  assertLoopback(typeof address === 'string' ? address : undefined, port);
  return udpConnect.call(this, port, address, ...rest);
};

function guardHostnameFirst(owner, name, rejects) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  const original = descriptor?.value;
  if (typeof original !== 'function' || !(descriptor.writable || descriptor.configurable)) return;
  const guarded = function (hostname, ...rest) {
    try {
      if (typeof hostname === 'string' && hostname !== '' && !net.isIP(hostname)) assertLoopback(hostname);
    } catch (error) {
      if (rejects) return Promise.reject(error);
      throw error;
    }
    return original.call(this, hostname, ...rest);
  };
  Object.defineProperties(guarded, Object.getOwnPropertyDescriptors(original));
  Object.defineProperty(owner, name, { ...descriptor, value: guarded });
}

const RESOLVERS = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt'];
for (const name of ['lookup', ...RESOLVERS]) {
  guardHostnameFirst(dns, name, false);
  guardHostnameFirst(dns.promises, name, true);
}
for (const name of RESOLVERS) {
  guardHostnameFirst(dns.Resolver.prototype, name, false);
  guardHostnameFirst(dns.promises.Resolver.prototype, name, true);
}
