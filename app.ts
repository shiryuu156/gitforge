// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL v4 and MCP
// from a single in-memory store. The entry (main.ts) binds an ephemeral port and registers
// it with the env; this file is the server that answers.
//
// Dispatch order: /healthz (boot probe, no auth) -> git smart HTTP -> REST /api/v3 ->
// GraphQL /api/graphql -> MCP /mcp -> JSON 404. The request body is read once and passed
// to the surface handler as bytes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { ForgeStore } from './src/store.ts';
import { parseUrl, readBody, sendError, sendJson } from './src/http-utils.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname } = parseUrl(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Read the body once (POST/PUT/PATCH/DELETE carry one). GET/HEAD requests in this
        // suite never carry a body, so skip the stream wait for them: awaiting 'end' costs
        // a tick per request, and the read workload is 2,000 sequential GETs.
        const hasBody =
          req.method !== 'GET' &&
          req.method !== 'HEAD' &&
          (req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined);
        const rawBody = hasBody ? await readBody(req) : Buffer.alloc(0);

        if (handleGit(req, res, rawBody, store)) return;
        if (handleRest(req, res, rawBody, store)) return;
        if (handleGraphQL(req, res, rawBody, store)) return;
        if (handleMcp(req, res, rawBody, store)) return;

        // Anything else: GitHub's JSON 404.
        sendError(res, 404, 'Not Found');
      } catch {
        // A handler must never take the server down: answer 500 JSON and keep serving.
        if (!res.headersSent) {
          try {
            sendError(res, 500, 'Internal Server Error');
          } catch {
            res.destroy();
          }
        } else {
          res.destroy();
        }
      }
    })();
  });
}
