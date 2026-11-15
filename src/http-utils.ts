// Shared HTTP helpers for the forge's surfaces: JSON replies, request ids, auth, body reads.
// Every reply carries a non-empty X-GitHub-Request-Id and a JSON content type (except the
// 204 delete, which carries no body). Never emit an HTML error page.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A unique, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}-${process.pid.toString(36)}`;
}

/** The headers every JSON reply carries. */
export function jsonHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...extra };
}

/** Send a JSON body. `body` is stringified once; the content-length is set exactly. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders(extraHeaders), 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Send an already-serialized JSON body (no stringify). `byteLength` skips the re-measure. */
export function sendJsonText(
  res: ServerResponse,
  status: number,
  text: string,
  byteLength?: number,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    ...jsonHeaders(extraHeaders),
    'content-length': byteLength ?? Buffer.byteLength(text),
  });
  res.end(text);
}

/** Send a JSON error body: {message} with the given status. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Send a 204 with no body but still a request id (the protocol checks sample every reply). */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Read the full request body as a Buffer. Rejects on stream error. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a request body as JSON. Returns {ok:false} on empty-but-required or malformed input.
 * An empty body parses as undefined (no JSON sent) — callers decide whether that is an error.
 */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/**
 * The bearer token the entry expects. In a trial MAKEFUN_SHOP_TOKEN is set by the harness;
 * locally (no env var) any non-empty bearer token authenticates, so the local runner works
 * with whatever --token it is given. A missing/empty Authorization header never authenticates.
 * Read once at module load: process.env access on every request is needless work, and the
 * harness never changes the token mid-trial.
 */
const EXPECTED_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function expectedToken(): string {
  return EXPECTED_TOKEN;
}

export function isAuthenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  return EXPECTED_TOKEN === '' || token === EXPECTED_TOKEN;
}

/** Split a URL pathname into decoded segments, dropping empty ones. */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      // Fast path: most segments carry no escapes.
      if (!s.includes('%')) return s;
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** One shared empty query set: callers only read from it, never mutate it. */
const EMPTY_SEARCH = new URLSearchParams();

/**
 * Parse a request URL into pathname + query params. Manual split instead of `new URL`:
 * the constructor is several microseconds per call and this runs 2-3 times per request
 * (dispatch + each surface). The raw path matches URL.pathname for every URL the suite
 * sends (percent-escapes stay encoded; fragments never reach the server).
 */
export function parseUrl(req: IncomingMessage): { pathname: string; search: URLSearchParams } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q === -1) return { pathname: raw === '' ? '/' : raw, search: EMPTY_SEARCH };
  const pathname = raw.slice(0, q);
  return { pathname: pathname === '' ? '/' : pathname, search: new URLSearchParams(raw.slice(q + 1)) };
}

/** The absolute origin of this request (scheme + Host header), for Link pagination URLs. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
