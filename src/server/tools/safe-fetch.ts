import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { ToolExecutionError } from './types';

const MAX_REDIRECTS = 3;
const MAX_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 80_000;
const REQUEST_TIMEOUT_MS = 10_000;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchResult {
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:') && isIP(normalized.slice(7)) === 4) {
    return isPrivateIpv4(normalized.slice(7));
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function assertSafeHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host === 'metadata.google.internal'
  ) {
    throw new ToolExecutionError('Fetching local or private hosts is not allowed.', 'URL_DENIED');
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new ToolExecutionError('Fetching local or private addresses is not allowed.', 'URL_DENIED');
  }
}

async function resolveSafe(url: URL): Promise<ResolvedAddress> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ToolExecutionError('Only http and https URLs are allowed.', 'URL_DENIED');
  }
  if (url.username || url.password) {
    throw new ToolExecutionError('URLs with embedded credentials are not allowed.', 'URL_DENIED');
  }
  assertSafeHostname(url.hostname);

  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new ToolExecutionError('Could not resolve the requested host.', 'URL_DENIED');
  }
  if (addresses.length === 0) {
    throw new ToolExecutionError('The requested host did not resolve.', 'URL_DENIED');
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new ToolExecutionError(
      'The requested host resolves to a local or private address.',
      'URL_DENIED',
    );
  }
  const selected = addresses[0];
  if (!selected) throw new ToolExecutionError('No public address was available.', 'URL_DENIED');
  return {
    address: selected.address,
    family: selected.family === 6 ? 6 : 4,
  };
}

function requestOnce(url: URL, resolved: ResolvedAddress, signal: AbortSignal): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  truncated: boolean;
}> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    let settled = false;
    let truncated = false;
    const chunks: Buffer[] = [];
    let received = 0;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn();
    };

    const lookupOverride: LookupFunction = (_hostname, _options, callback) => {
      (callback as unknown as (error: NodeJS.ErrnoException | null, address: string, family: number) => void)(
        null,
        resolved.address,
        resolved.family,
      );
    };

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(
      url,
      {
        method: 'GET',
        lookup: lookupOverride,
        headers: {
          accept: 'text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1',
          'user-agent': 'PixelAgentOffice/0.1 (+local agent workspace)',
          'accept-encoding': 'identity',
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = response.headers;
        response.on('data', (chunk: Buffer) => {
          if (settled) return;
          received += chunk.length;
          if (received > MAX_BYTES) {
            truncated = true;
            response.destroy();
            finish(() =>
              resolve({
                status,
                headers,
                body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8'),
                truncated,
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          finish(() =>
            resolve({
              status,
              headers,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            }),
          );
        });
        response.on('error', (error) => {
          finish(() => reject(error));
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('The remote server timed out.'));
    });
    request.on('error', (error) => {
      finish(() => reject(error));
    });
    const onAbort = () => {
      request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
      finish(() => reject(new DOMException('The operation was aborted.', 'AbortError')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

/**
 * Fetches a public text resource. DNS is checked then pinned to the validated
 * address, redirects are re-validated, credentials are rejected, and responses
 * are bounded. The tool is opt-in and always approval-gated.
 */
export async function fetchPublicText(rawUrl: string, signal: AbortSignal): Promise<FetchResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new ToolExecutionError('A valid absolute URL is required.', 'INVALID_INPUT');
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resolved = await resolveSafe(current);
    let response;
    try {
      response = await requestOnce(current, resolved, signal);
    } catch (error) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      throw new ToolExecutionError(
        `Fetch failed: ${error instanceof Error ? error.message : 'unknown network error'}`,
        'FETCH_FAILED',
      );
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location) {
        throw new ToolExecutionError('The remote server sent a redirect without a location.', 'FETCH_FAILED');
      }
      current = new URL(location, current);
      continue;
    }

    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    const allowed =
      !contentType ||
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml') ||
      contentType.includes('javascript') ||
      contentType.includes('x-www-form-urlencoded');
    if (!allowed) {
      throw new ToolExecutionError(
        `Response content type "${contentType}" is not a text format.`,
        'CONTENT_DENIED',
      );
    }

    const text = response.body.slice(0, MAX_TEXT_CHARS);
    return {
      status: response.status,
      finalUrl: current.toString(),
      contentType,
      text,
      truncated: response.truncated || response.body.length > MAX_TEXT_CHARS,
    };
  }

  throw new ToolExecutionError('Too many redirects.', 'FETCH_FAILED');
}
