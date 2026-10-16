import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { checkEndpoint, isPublicAddress, validateEndpointUrl, type CheckConfig } from '../src/endpoint-checker.js';

const config: CheckConfig = { url: 'https://health.example.com/health', method: 'GET', timeoutMs: 1000, expectedStatusMin: 200, expectedStatusMax: 299 };
const publicAddresses = async () => [{ address: '93.184.216.34', family: 4 }];

test('endpoint validation rejects credentials, unsupported schemes, local names and encoded private literals', () => {
  for (const url of ['ftp://example.com', 'https://user:secret@example.com', 'https://localhost', 'http://localhost.',
    'http://service.local', 'http://internal', 'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001',
    'http://10.1.2.3', 'http://169.254.169.254', 'http://100.64.0.1', 'http://192.0.2.1', 'http://224.0.0.1',
    'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[2001:db8::1]',
    'http://[3fff::1]', 'http://[1000::1]', 'https://example.com/#fragment']) {
    assert.throws(() => validateEndpointUrl(url), /public HTTP/);
  }
  assert.equal(validateEndpointUrl('https://example.com/health?full=true').hostname, 'example.com');
  assert.equal(validateEndpointUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('not-an-address'), false);
});

test('every DNS answer must be public, including IPv6 answers', async () => {
  for (const blocked of ['10.0.0.1', '127.0.0.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:8.8.8.8']) {
    let requests = 0;
    const result = await checkEndpoint(config, {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: blocked, family: blocked.includes(':') ? 6 : 4 }],
      request: () => { requests++; throw new Error('must not connect'); },
    });
    assert.equal(result.failureReason, 'unsafe_address');
    assert.equal(requests, 0);
  }
});

test('DNS is performed once and the validated IP is pinned while preserving the TLS hostname', async () => {
  let resolutions = 0;
  let response: IncomingMessage | undefined;
  const result = await checkEndpoint(config, {
    resolve: async () => { resolutions++; return publicAddresses(); },
    request: (options, receive) => {
      assert.equal(options.hostname, 'health.example.com');
      assert.equal(options.agent, false);
      assert.equal(options.family, 4);
      const pinned = options.lookup as (hostname: string, options: object, callback: (...values: unknown[]) => void) => void;
      pinned('rebound.example.com', {}, (...values) => assert.deepEqual(values, [null, '93.184.216.34', 4]));
      pinned('rebound.example.com', { all: true }, (...values) => assert.deepEqual(values, [null, [{ address: '93.184.216.34', family: 4 }]]));
      const request = new EventEmitter() as ClientRequest;
      request.destroy = () => request;
      request.end = (() => {
        response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = 204;
        receive(response);
        return request;
      }) as ClientRequest['end'];
      return request;
    },
  });
  assert.equal(resolutions, 1);
  assert.equal(result.success, true);
  assert.equal(result.httpStatus, 204);
  assert.equal(response?.destroyed, true, 'response bodies must never be buffered');
});

test('one deadline covers DNS and late DNS resolution cannot open a socket', async () => {
  let release!: (addresses: { address: string; family: number }[]) => void;
  let requests = 0;
  const result = await checkEndpoint({ ...config, timeoutMs: 15 }, {
    resolve: () => new Promise(resolve => { release = resolve; }),
    request: () => { requests++; throw new Error('must not connect'); },
  });
  assert.equal(result.failureReason, 'timeout');
  release(await publicAddresses());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
});

test('DNS failures and empty DNS answers are recorded as check outcomes', async () => {
  assert.equal((await checkEndpoint(config, { resolve: async () => { throw new Error('ENOTFOUND'); } })).failureReason, 'dns_failure');
  assert.equal((await checkEndpoint(config, { resolve: async () => [] })).failureReason, 'unsafe_address');
  assert.equal((await checkEndpoint({ ...config, url: 'http://127.0.0.1/' })).failureReason, 'unsafe_endpoint');
});

test('invalid stored configuration is an internal failure instead of an endpoint failure', async () => {
  await assert.rejects(checkEndpoint({ ...config, timeoutMs: -1 }), /stored check configuration/);
});

test('native HTTP rejects redirects, times out before headers, and closes unbounded response bodies', async () => {
  let redirectedRequests = 0;
  let requestedMethod = '';
  const server = http.createServer((req, res) => {
    requestedMethod = req.method ?? '';
    if (req.url === '/redirect') { res.writeHead(302, { location: '/followed' }); res.end(); }
    else if (req.url === '/followed') { redirectedRequests++; res.end('wrong'); }
    else if (req.url === '/slow') { /* Client deadline must terminate this connection. */ }
    else { res.writeHead(200); res.flushHeaders(); /* Intentionally never ends the response body. */ }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  // Test transport reaches a local fixture only after production validation and pinning are exercised.
  const request = (options: RequestOptions, response: (message: IncomingMessage) => void) => http.request({
    ...options, hostname: '127.0.0.1', port: address.port, lookup: undefined,
  }, response);
  try {
    const check = (path: string, timeoutMs = 1000, method: 'GET' | 'HEAD' = 'GET') => checkEndpoint({ ...config, url: `http://health.example.com${path}`, timeoutMs, method }, { resolve: publicAddresses, request });
    assert.equal((await check('/redirect')).failureReason, 'redirect_not_followed');
    assert.equal(redirectedRequests, 0);
    assert.equal((await check('/slow', 25)).failureReason, 'timeout');
    assert.equal((await check('/headers')).success, true);
    assert.equal((await check('/headers', 1000, 'HEAD')).success, true);
    assert.equal(requestedMethod, 'HEAD');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
