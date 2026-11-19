// app.ts — the HTTP server: routing, auth, body handling.
//
// Surfaces:
//   GET  /healthz                        boot probe, no auth
//   /api/v3/*                            REST v3 (Bearer required except root/meta)
//   POST /api/graphql                    GraphQL v4 (Bearer required)
//   POST /mcp, DELETE /mcp              MCP (Bearer required on POST)
//   /{owner}/{repo}.git/info/refs       git smart HTTP advertisement (Bearer required)
//   /{owner}/{repo}.git/git-upload-pack git smart HTTP fetch (Bearer required)
//   /{owner}/{repo}.git/git-receive-pack
//                                        git smart HTTP push (Bearer required)
// Everything else answers a JSON 404. Every REST reply carries a
// non-empty X-GitHub-Request-Id and application/json.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { routeRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface AppOptions {
  /** The expected bearer token; null accepts any non-empty bearer token. */
  token: string | null;
}

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...(extraHeaders ?? {}),
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match !== null ? (match[1] as string) : null;
}

function isAuthed(options: AppOptions, req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (options.token === null) return true;
  return token === options.token;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

async function handleRequest(store: Store, options: AppOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = req.headers.host ?? '127.0.0.1';
  const fullUrl = `http://${host}${req.url ?? '/'}`;
  const url = new URL(fullUrl);
  const method = req.method ?? 'GET';
  const segments = decodeSegments(url.pathname);

  // Boot probe.
  if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -4);
    const repo = store.getRepo(owner, repoName);
    const service = segments[2] as string | undefined;
    if (!isAuthed(options, req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    if (method === 'GET' && service === 'info' && segments[3] === 'refs') {
      const serviceParam = url.searchParams.get('service');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service parameter is required' });
        return;
      }
      const result = handleInfoRefs(store, repo, serviceParam, req.headers['git-protocol'] ?? null);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && service === 'git-upload-pack') {
      const body = await readBody(req);
      const result = handleUploadPack(store, repo, body, req.headers['git-protocol'] ?? null);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    if (method === 'POST' && service === 'git-receive-pack') {
      const body = await readBody(req);
      const result = handleReceivePack(store, repo, body);
      sendBuffer(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL.
  if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthed(options, req)) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
      return;
    }
    const result = handleGraphql(store, parsed);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (segments.length === 1 && segments[0] === 'mcp') {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!isAuthed(options, req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw.toString('utf8'));
    sendJson(res, result.status, result.body, result.headers);
    return;
  }

  // REST v3.
  if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const isPublic = restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta');
    if (!isPublic && !isAuthed(options, req)) {
      sendJson(res, 401, { message: 'Unauthorized' }, { 'X-GitHub-Request-Id': `req-${++store.seq}` });
      return;
    }
    let parsedBody: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          parsedBody = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Request body is not valid JSON.' }, { 'X-GitHub-Request-Id': `req-${++store.seq}` });
          return;
        }
      }
    }
    const result = routeRest(store, method, restSegments, url.searchParams, fullUrl, parsedBody);
    const headers: Record<string, string> = { 'X-GitHub-Request-Id': `req-${++store.seq}`, ...(result.headers ?? {}) };
    sendJson(res, result.status, result.body, headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(options: AppOptions): { server: ReturnType<typeof createServer>; store: Store } {
  const store = new Store();
  const server = createServer((req, res) => {
    void handleRequest(store, options, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : 'Internal Server Error';
        sendJson(res, 500, { message });
      } else {
        res.destroy();
      }
    });
  });
  return { server, store };
}
