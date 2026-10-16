import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import ipaddr from 'ipaddr.js';
import { HttpError } from './core.js';

export interface CheckConfig {
  url: string;
  method: 'GET' | 'HEAD';
  timeoutMs: number;
  expectedStatusMin: number;
  expectedStatusMax: number;
}
export interface CheckOutcome {
  success: boolean;
  httpStatus: number | null;
  latencyMs: number;
  failureReason: string | null;
}
type Address = { address: string; family: number };
export interface CheckerDependencies {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: (options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest;
}

/** Only ordinary, globally routable addresses are eligible monitoring targets. */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // IPv6 addresses outside the current global-unicast allocation are reserved.
  return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parseCIDR('2000::/3'));
}

export function validateEndpointUrl(input: string): URL {
  const invalid = () => new HttpError(400, 'INVALID_ENDPOINT', 'Use a public HTTP or HTTPS endpoint without embedded credentials or a fragment.');
  if (typeof input !== 'string' || input.length > 2048) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid();
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|lan|home|invalid|test)$/.test(hostname)) throw invalid();
  if (isIP(hostname)) { if (!isPublicAddress(hostname)) throw invalid(); }
  else if (!hostname.includes('.')) throw invalid();
  return url;
}

/** Checks response headers only. Bodies are discarded immediately and redirects are never followed. */
export async function checkEndpoint(config: CheckConfig, dependencies: CheckerDependencies = {}): Promise<CheckOutcome> {
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0 || !['GET', 'HEAD'].includes(config.method)
    || !Number.isInteger(config.expectedStatusMin) || !Number.isInteger(config.expectedStatusMax)
    || config.expectedStatusMin < 100 || config.expectedStatusMax > 599 || config.expectedStatusMin > config.expectedStatusMax) {
    throw new Error('Invalid stored check configuration');
  }
  const started = performance.now();
  return new Promise<CheckOutcome>((resolve, reject) => {
    let settled = false;
    let request: ClientRequest | undefined;
    const finish = (success: boolean, httpStatus: number | null, failureReason: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success, httpStatus, failureReason, latencyMs: Math.max(0, Math.round(performance.now() - started)) });
    };
    // This single deadline includes DNS, TCP, TLS and response headers. Socket inactivity alone is insufficient.
    const timer = setTimeout(() => {
      finish(false, null, 'timeout');
      request?.destroy();
    }, config.timeoutMs);
    void (async () => {
      let url: URL;
      try { url = validateEndpointUrl(config.url); } catch { finish(false, null, 'unsafe_endpoint'); return; }
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: Address[];
      try {
        addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
          : await (dependencies.resolve ?? (name => lookup(name, { all: true, verbatim: true })))(hostname);
      } catch { finish(false, null, 'dns_failure'); return; }
      if (settled) return; // A DNS answer arriving after the deadline must never open a connection.
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
        finish(false, null, 'unsafe_address'); return;
      }
      const selected = addresses[0]!;
      const options: RequestOptions = {
        protocol: url.protocol, hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
        method: config.method, agent: false, family: selected.family,
        maxHeaderSize: 16 * 1024,
        headers: { 'user-agent': 'StatusPulse/0.1', accept: '*/*', connection: 'close' },
        // Keep the hostname for HTTP Host and TLS verification; pin the validated address for the actual socket.
        lookup: (_name, lookupOptions, callback) => {
          if (lookupOptions.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      };
      try {
        const makeRequest = dependencies.request ?? (url.protocol === 'https:' ? https.request : http.request);
        request = makeRequest(options, response => {
          const status = response.statusCode ?? 0;
          const redirect = status >= 300 && status < 400;
          const success = !redirect && status >= config.expectedStatusMin && status <= config.expectedStatusMax;
          finish(success, status || null, redirect ? 'redirect_not_followed' : success ? null : 'unexpected_http_status');
          // HTTP status and time-to-headers are our contract. Never buffer, decompress or download a response body.
          response.destroy();
          request?.destroy();
        });
        request.on('error', () => finish(false, null, 'connection_failure'));
        request.end();
      } catch { finish(false, null, 'connection_failure'); request?.destroy(); }
    })().catch(error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      reject(error);
    });
  });
}
