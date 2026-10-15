'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, clientAddress } = require('../lib/ratelimit');

const req = (xff, remote = '10.0.0.1') => ({ headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, socket: { remoteAddress: remote } });

test('the client-supplied leftmost X-Forwarded-For entry is never trusted', () => {
  assert.equal(clientAddress(req('6.6.6.6, 1.2.3.4')), '1.2.3.4');
  assert.equal(clientAddress(req('6.6.6.6, 9.9.9.9, 1.2.3.4'), { hops: 2 }), '9.9.9.9');
});

test('hops beyond the chain fall back to its start; no header uses the socket', () => {
  assert.equal(clientAddress(req('1.2.3.4'), { hops: 2 }), '1.2.3.4');
  assert.equal(clientAddress(req(undefined)), '10.0.0.1');
  assert.equal(clientAddress(req('6.6.6.6'), { trustProxy: false }), '10.0.0.1');
});

test('limiter allows max requests per window per key', () => {
  const l = createLimiter({ windowMs: 60000, max: 3 });
  const seen = [1, 2, 3, 4].map(() => l.check('a').ok);
  assert.deepEqual(seen, [true, true, true, false]);
  assert.equal(l.check('b').ok, true);
  clearInterval(l._timer);
});
