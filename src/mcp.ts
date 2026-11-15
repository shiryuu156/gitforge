// Model Context Protocol over streamable HTTP at POST /mcp (see spec-graphql-mcp.md Part B).
// Serves the modern era (revision 2026-07-28: server/discover, no handshake) and answers the
// legacy initialize handshake too. Six tools share the REST store: create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request.
// Error contract: unknown tool -> -32602; missing args -> -32602; malformed body -> HTTP 400
// + -32700; no auth -> HTTP 401. tools/list is byte-identical across calls (one frozen array).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { branchRef, refTip, squashMerge } from './git-repo.ts';
import { VIEWER, type ForgeStore, type Repo } from './store.ts';
import { isAuthenticated, nextRequestId, parseUrl } from './http-utils.ts';

const SERVER_NAME = 'makefun-github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: readonly string[];
  };
}

/** The tool list, built once: byte-identical across calls (tools-list-idempotent). */
const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
]);

const TOOL_ALIASES: Record<string, string> = {
  create_repository: 'create_repo',
  repo_create: 'create_repo',
  repos_create: 'create_repo',
  repository_create: 'create_repo',
  get_repository: 'get_repo',
  repo_get: 'get_repo',
  repos_get: 'get_repo',
  repository_get: 'get_repo',
  issue_create: 'create_issue',
  issues_create: 'create_issue',
  issues_list: 'list_issues',
  issue_list: 'list_issues',
  pull_request_create: 'create_pull_request',
  pulls_create: 'create_pull_request',
  create_pr: 'create_pull_request',
  pr_create: 'create_pull_request',
  pull_request_merge: 'merge_pull_request',
  pulls_merge: 'merge_pull_request',
  merge_pr: 'merge_pull_request',
  pr_merge: 'merge_pull_request',
};

/** Normalize a tool name the way the suite's findTool does: lowercase, alphanumerics only. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Resolve a requested tool name to a canonical tool (exact, alias, or suffix match). */
function resolveTool(name: string): ToolDef | undefined {
  const normalized = normalizeName(name);
  for (const tool of TOOLS) {
    if (normalizeName(tool.name) === normalized) return tool;
  }
  const aliased = TOOL_ALIASES[normalized];
  if (aliased !== undefined) return TOOLS.find((tool) => tool.name === aliased);
  // Suffix match: a server-prefixed name ending in the wanted name.
  for (const tool of TOOLS) {
    const wanted = normalizeName(tool.name);
    if (normalized.length > wanted.length && normalized.endsWith(wanted)) return tool;
  }
  return undefined;
}

// ---------------------------------------------------------------- JSON-RPC plumbing

type JsonRpcId = string | number | null;

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
  });
  res.end(text);
}

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendRpc(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: JsonRpcId, code: number, message: string, status = 200, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendRpc(res, status, { jsonrpc: '2.0', id, error });
}

/** A tool result carrying the identifying data as both text and structured content. */
function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Try to salvage a JSON-RPC id from a malformed body (the suite's parse-error probe). */
function salvageId(raw: Buffer): JsonRpcId {
  const text = raw.toString('utf8');
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(text);
  if (match === null) return null;
  try {
    return JSON.parse(match[1] as string) as JsonRpcId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- tool execution

type Args = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function lookupRepo(store: ForgeStore, args: Args): Repo | undefined {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner === undefined || repo === undefined) return undefined;
  if (owner !== VIEWER.login) return undefined;
  return store.getRepo(owner, repo);
}

function callTool(store: ForgeStore, tool: ToolDef, args: Args): { error?: { code: number; message: string }; result?: Record<string, unknown> } {
  // Validate required arguments first (missing-arguments check expects -32602 or isError).
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { error: { code: -32602, message: `Missing required argument: ${required}` } };
    }
  }

  switch (tool.name) {
    case 'create_repo': {
      const name = args.name as string;
      const repo = store.createRepo(name, args.private === true, asString(args.description) ?? '');
      if (repo === null) return { result: toolErrorResult(`Repository "${name}" already exists.`) };
      return {
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: repo.owner,
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
        }),
      };
    }
    case 'get_repo': {
      const repo = lookupRepo(store, args);
      if (repo === undefined) return { result: toolErrorResult('Repository not found.') };
      return {
        result: toolResult({
          id: repo.id,
          name: repo.name,
          full_name: `${repo.owner}/${repo.name}`,
          owner: repo.owner,
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
        }),
      };
    }
    case 'create_issue': {
      const repo = lookupRepo(store, args);
      if (repo === undefined) return { result: toolErrorResult('Repository not found.') };
      const issue = store.createIssue(repo, args.title as string, asString(args.body) ?? '', []);
      return {
        result: toolResult({
          id: repo.id * 1_000_000 + issue.number,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        }),
      };
    }
    case 'list_issues': {
      const repo = lookupRepo(store, args);
      if (repo === undefined) return { result: toolErrorResult('Repository not found.') };
      const state = asString(args.state);
      const issues = repo.issues
        .filter((issue) => state === undefined || state === 'all' || issue.state === state)
        .map((issue) => ({ id: repo.id * 1_000_000 + issue.number, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
      return { result: toolResult({ issues }) };
    }
    case 'create_pull_request': {
      const repo = lookupRepo(store, args);
      if (repo === undefined) return { result: toolErrorResult('Repository not found.') };
      const head = args.head as string;
      const base = args.base as string;
      const headSha = refTip(repo, branchRef(head));
      const baseSha = refTip(repo, branchRef(base));
      if (headSha === undefined || baseSha === undefined) {
        return { result: toolErrorResult('Head or base branch does not exist.') };
      }
      const pull = store.createPull(repo, args.title as string, asString(args.body) ?? '', head, base, headSha, baseSha);
      return {
        result: toolResult({
          id: repo.id * 1_000_000 + pull.number,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head,
          base,
          head_ref: head,
          base_ref: base,
        }),
      };
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(store, args);
      if (repo === undefined) return { result: toolErrorResult('Repository not found.') };
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (pull === undefined) return { result: toolErrorResult('Pull request not found.') };
      if (pull.state === 'closed') {
        return { result: toolErrorResult('Pull request is already closed.') };
      }
      const result = squashMerge(repo, pull.head, pull.base, pull.number);
      if (!result.ok) return { result: toolErrorResult('Pull request is not mergeable.') };
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date().toISOString();
      pull.mergeCommitSha = result.commitSha;
      return {
        result: toolResult({
          merged: true,
          number: pull.number,
          sha: result.commitSha,
          message: 'Pull request successfully merged',
        }),
      };
    }
    default:
      return { error: { code: -32602, message: `Unknown tool: ${tool.name}` } };
  }
}

// ---------------------------------------------------------------- handler

/**
 * Handle POST /mcp. Returns true when the path matched (handled); false otherwise.
 * Notifications (requests without an id) are answered 202 with an empty body.
 */
export function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer, store: ForgeStore): boolean {
  const { pathname } = parseUrl(req);
  if (pathname !== '/mcp') return false;

  if ((req.method ?? 'GET') === 'DELETE') {
    // Legacy session close: best-effort, always accepted.
    res.writeHead(200, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendRpc(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not found' } });
    return true;
  }

  // Auth is decided before any method handling (auth-required check expects HTTP 401).
  if (!isAuthenticated(req)) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': nextRequestId(),
    });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } }));
    return true;
  }

  // Malformed JSON -> HTTP 400 + JSON-RPC -32700 (parse-error check).
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rpcError(res, null, -32600, 'Invalid Request', 400);
      return true;
    }
    request = parsed as Record<string, unknown>;
  } catch {
    rpcError(res, salvageId(rawBody), -32700, 'Parse error', 400);
    return true;
  }

  const id = (request.id as JsonRpcId | undefined) ?? null;
  const isNotification = request.id === undefined;
  const method = request.method as string | undefined;
  const params = (request.params !== null && typeof request.params === 'object' ? request.params : {}) as Record<string, unknown>;

  // Notifications get no JSON-RPC response (202, empty body).
  if (isNotification) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      rpcResult(res, id, {
        resultType: 'server/discover',
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible git forge: create repos, issues and pull requests.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return true;
    }
    case 'initialize': {
      const offered = params.protocolVersion as string | undefined;
      if (offered !== undefined && offered !== MODERN_REVISION && !LEGACY_REVISIONS.includes(offered)) {
        // Unknown revision: -32602 lets the client try the next older one.
        rpcError(res, id, -32602, `Unsupported protocol version: ${offered}`);
        return true;
      }
      rpcResult(res, id, {
        protocolVersion: offered ?? LEGACY_REVISIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = params.name as string | undefined;
      if (typeof name !== 'string' || name === '') {
        rpcError(res, id, -32602, 'Missing tool name');
        return true;
      }
      const tool = resolveTool(name);
      if (tool === undefined) {
        rpcError(res, id, -32602, `Unknown tool: ${name}`);
        return true;
      }
      const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Args;
      const outcome = callTool(store, tool, args);
      if (outcome.error !== undefined) {
        rpcError(res, id, outcome.error.code, outcome.error.message);
        return true;
      }
      rpcResult(res, id, outcome.result);
      return true;
    }
    default: {
      rpcError(res, id, -32601, `Method not found: ${method ?? '(none)'}`);
      return true;
    }
  }
}
