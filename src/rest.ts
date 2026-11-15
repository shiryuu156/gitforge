// GitHub REST v3 API under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests, files, merges. Implements the contract in spec-rest.md:
// exact statuses, JSON everywhere, X-GitHub-Request-Id on every reply, 401 without a token,
// 404 (never 403) for a foreign owner.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  branchRef,
  commitFile,
  commitTree,
  deleteFile,
  diffTrees,
  flattenTree,
  listHistory,
  mergeBase,
  readTreePath,
  refTip,
  resolveRef,
  squashMerge,
} from './git-repo.ts';
import { VIEWER, type ForgeStore, type Issue, type Pull, type Repo } from './store.ts';
import {
  isAuthenticated,
  jsonHeaders,
  parseJsonBody,
  parseUrl,
  pathSegments,
  requestOrigin,
  sendError,
  sendJson,
  sendJsonText,
  sendNoContent,
} from './http-utils.ts';

// ---------------------------------------------------------------- serializers

/** Stable REST `id` for an issue or pull: repo id in the high digits, number in the low ones. */
function resourceId(repo: Repo, number: number): number {
  return repo.id * 1_000_000 + number;
}

/** The token owner's user object, constant for the server's life: build once, reuse. */
const USER_JSON: Record<string, unknown> = Object.freeze({
  login: VIEWER.login,
  id: VIEWER.id,
  name: VIEWER.name,
  email: VIEWER.email,
  type: 'User',
});

function userJson(): Record<string, unknown> {
  return USER_JSON;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    pushed_at: '2026-01-01T00:00:00Z',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    fork: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed', description: '' };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: resourceId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    comments: issue.comments.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: issue.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
  };
}

/** The issue's serialized REST JSON, cached on the issue (see store.ts Issue.jsonCache). */
function issueJsonText(repo: Repo, issue: Issue): { text: string; byteLength: number } {
  const cached = issue.jsonCache;
  if (cached !== null) return cached;
  const text = JSON.stringify(issueJson(repo, issue));
  const entry = { text, byteLength: Buffer.byteLength(text) };
  issue.jsonCache = entry;
  return entry;
}

/** Drop every issue's cached JSON in a repo (label colors feed into issue bodies). */
function invalidateIssueCaches(repo: Repo): void {
  for (const issue of repo.issues) issue.jsonCache = null;
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: resourceId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: userJson(), repo: repoJson(repo) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: userJson(), repo: repoJson(repo) },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: true,
    mergeable_state: 'clean',
    draft: false,
    locked: false,
    user: userJson(),
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: pull.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
  };
}

// ---------------------------------------------------------------- helpers

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Body) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Look up a repo for a route; sends 404 and returns undefined when absent or foreign-owned. */
function lookupRepo(store: ForgeStore, res: ServerResponse, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) {
    sendError(res, 404, 'Not Found');
    return undefined;
  }
  const repo = store.getRepo(owner, name);
  if (repo === undefined) {
    sendError(res, 404, 'Not Found');
    return undefined;
  }
  return repo;
}

// ---------------------------------------------------------------- handler

/**
 * Handle one REST request. `rawBody` is the request body bytes (already read). Returns true
 * when the path was a REST route (handled, even as a 404/401); false when the path is not
 * under /api/v3 at all (caller tries other surfaces).
 */
export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  store: ForgeStore,
): boolean {
  const { pathname, search } = parseUrl(req);
  if (pathname !== '/api/v3' && pathname !== '/api/v3/' && !pathname.startsWith('/api/v3/')) return false;
  const method = req.method ?? 'GET';

  // Auth first: every /api/v3 route needs a token (missing or wrong -> 401 JSON).
  if (!isAuthenticated(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  const segments = pathSegments(pathname); // e.g. ['api','v3','repos',owner,name,'issues','1']
  const rest = segments.slice(2); // drop 'api','v3'

  // Parse a JSON body for methods that carry one; malformed JSON -> 400.
  let body: unknown;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
    body = parsed.value;
  }
  const json = asBody(body);

  // ---- API root and meta -------------------------------------------------
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    } else {
      sendError(res, 404, 'Not Found');
    }
    return true;
  }

  if (rest.length === 1 && rest[0] === 'meta') {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0' });
    else sendError(res, 404, 'Not Found');
    return true;
  }

  if (rest.length === 1 && rest[0] === 'user') {
    if (method === 'GET') {
      sendJson(res, 200, { ...userJson(), public_repos: store.listRepos().length });
    } else {
      sendError(res, 404, 'Not Found');
    }
    return true;
  }

  // ---- /user/repos -------------------------------------------------------
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const name = asString(json.name);
      if (name === undefined || name === '') {
        sendError(res, 422, 'Validation Failed');
        return true;
      }
      const repo = store.createRepo(name, asBoolean(json.private) ?? false, asString(json.description) ?? '');
      if (repo === null) {
        sendError(res, 422, 'Repository creation failed. Name already exists on this account.');
        return true;
      }
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(search.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1);
      const all = store.listRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const headers: Record<string, string> = {};
      if (page < totalPages) {
        const origin = requestOrigin(req);
        const links = [
          `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`,
          `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}>; rel="last"`,
        ];
        if (page > 1) {
          links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=1>; rel="first"`);
          links.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
        }
        headers.link = links.join(', ');
      }
      // Send with the Link header beside the JSON ones.
      const text = JSON.stringify(items.map((repo) => repoJson(repo)));
      res.writeHead(200, { ...jsonHeaders(headers), 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // ---- /repos/{owner}/{repo}/... ------------------------------------------
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1] as string;
    const repoName = rest[2] as string;
    const tail = rest.slice(3);

    // The repo itself.
    if (tail.length === 0) {
      if (method === 'GET') {
        const repo = lookupRepo(store, res, owner, repoName);
        if (repo !== undefined) sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = lookupRepo(store, res, owner, repoName);
        if (repo === undefined) return true;
        const description = asString(json.description);
        if (description !== undefined) repo.description = description;
        const isPrivate = asBoolean(json.private);
        if (isPrivate !== undefined) repo.private = isPrivate;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = lookupRepo(store, res, owner, repoName);
        if (repo === undefined) return true;
        store.deleteRepo(owner, repoName);
        sendNoContent(res);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    const repo = lookupRepo(store, res, owner, repoName);
    if (repo === undefined) return true;

    // ---- branches --------------------------------------------------------
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        sendJson(
          res,
          200,
          branches.map((name) => ({
            name,
            commit: { sha: repo.refs.get(branchRef(name)) as string },
            protected: false,
          })),
        );
        return true;
      }
      if (tail.length >= 2 && method === 'GET') {
        // Branch names may contain slashes: take the rest of the path.
        const branch = tail.slice(1).join('/');
        const sha = refTip(repo, branchRef(branch));
        if (sha === undefined) {
          sendError(res, 404, 'Branch not found');
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- git/refs --------------------------------------------------------
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const ref = asString(json.ref);
        const sha = asString(json.sha);
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        repo.refs.set(ref, sha.toLowerCase());
        sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
        return true;
      }
      if (tail.length >= 3 && method === 'GET') {
        // GET /git/refs/heads/<branch...> — branch names may contain slashes.
        const ref = `refs/${tail.slice(2).join('/')}`;
        const sha = refTip(repo, ref);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- commits ---------------------------------------------------------
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const refish = search.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refish);
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const history = listHistory(repo.objects, tip);
      sendJson(
        res,
        200,
        history.map((info) => ({
          sha: info.sha,
          commit: {
            message: info.message,
            author: { name: VIEWER.name, email: VIEWER.email },
            committer: { name: VIEWER.name, email: VIEWER.email },
          },
          author: userJson(),
          committer: userJson(),
          parents: info.parents.map((sha) => ({ sha })),
        })),
      );
      return true;
    }

    // ---- contents --------------------------------------------------------
    if (tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (filePath === '') {
        // Root listing is untested; answer the top-level tree like GitHub does.
        if (method === 'GET') {
          const tip = refTip(repo, branchRef(repo.defaultBranch));
          if (tip === undefined) {
            sendJson(res, 200, []);
            return true;
          }
          const treeOid = commitTree(repo.objects, tip);
          const entries = treeOid === undefined ? [] : repo.objects.treeEntries(treeOid) ?? [];
          sendJson(
            res,
            200,
            entries.map((entry) => ({
              type: entry.mode === '40000' ? 'dir' : 'file',
              name: entry.name,
              path: entry.name,
              sha: entry.oid,
            })),
          );
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        const refish = search.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, refish);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = commitTree(repo.objects, tip);
        if (treeOid === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const found = readTreePath(repo.objects, treeOid, filePath);
        if (found === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (found.kind === 'file') {
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: found.data.toString('base64'),
            sha: found.oid,
            size: found.data.length,
            name: filePath.split('/').pop() as string,
            path: filePath,
          });
          return true;
        }
        sendJson(
          res,
          200,
          found.entries.map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: `${filePath}/${entry.name}`,
            sha: entry.oid,
          })),
        );
        return true;
      }
      if (method === 'PUT') {
        const message = asString(json.message) ?? '';
        const contentB64 = asString(json.content);
        if (contentB64 === undefined) {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        const content = Buffer.from(contentB64, 'base64');
        const branch = asString(json.branch) ?? repo.defaultBranch;
        const sentSha = asString(json.sha);
        // Does the file already exist on this branch?
        const tip = refTip(repo, branchRef(branch));
        let currentSha: string | undefined;
        if (tip !== undefined) {
          const treeOid = commitTree(repo.objects, tip);
          if (treeOid !== undefined) {
            const found = readTreePath(repo.objects, treeOid, filePath);
            if (found !== undefined && found.kind === 'file') currentSha = found.oid;
          }
        }
        if (currentSha !== undefined) {
          // Update: the sent sha must be the current blob sha.
          if (sentSha === undefined || sentSha.toLowerCase() !== currentSha.toLowerCase()) {
            sendError(res, 409, 'Conflict: the file has changed since the given sha.');
            return true;
          }
          const { commitSha, blobSha } = commitFile(repo, branch, filePath, content, message);
          sendJson(res, 200, {
            content: { sha: blobSha, encoding: 'base64', name: filePath.split('/').pop(), path: filePath, size: content.length },
            commit: { sha: commitSha },
          });
          return true;
        }
        // Create (201), on an unborn repo or a new path.
        const { commitSha, blobSha } = commitFile(repo, branch, filePath, content, message);
        sendJson(res, 201, {
          content: { sha: blobSha, encoding: 'base64', name: filePath.split('/').pop(), path: filePath, size: content.length },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === 'DELETE') {
        const message = asString(json.message) ?? '';
        const sentSha = asString(json.sha);
        const branch = asString(json.branch) ?? repo.defaultBranch;
        const tip = refTip(repo, branchRef(branch));
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const treeOid = commitTree(repo.objects, tip);
        const found = treeOid === undefined ? undefined : readTreePath(repo.objects, treeOid, filePath);
        if (found === undefined || found.kind !== 'file') {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (sentSha !== undefined && sentSha.toLowerCase() !== found.oid.toLowerCase()) {
          sendError(res, 409, 'Conflict: the file has changed since the given sha.');
          return true;
        }
        const commitSha = deleteFile(repo, branch, filePath, message);
        if (commitSha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { commit: { sha: commitSha } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- labels ----------------------------------------------------------
    if (tail[0] === 'labels' && tail.length === 1) {
      if (method === 'POST') {
        const name = asString(json.name);
        if (name === undefined || name === '') {
          sendError(res, 422, 'Validation Failed');
          return true;
        }
        const color = asString(json.color) ?? 'ededed';
        repo.labels.set(name, { name, color });
        invalidateIssueCaches(repo); // label colors feed into cached issue bodies
        sendJson(res, 201, { name, color, description: '' });
        return true;
      }
      if (method === 'GET') {
        sendJson(
          res,
          200,
          [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: '' })),
        );
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- issues ----------------------------------------------------------
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const title = asString(json.title);
          if (title === undefined) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          const bodyText = asString(json.body) ?? '';
          const labels = Array.isArray(json.labels) ? (json.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(res, 422, `Validation Failed: label "${label}" does not exist.`);
              return true;
            }
          }
          const issue = store.createIssue(repo, title, bodyText, labels);
          const serialized = issueJsonText(repo, issue);
          sendJsonText(res, 201, serialized.text, serialized.byteLength);
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state');
          const sort = search.get('sort');
          const direction = search.get('direction') ?? 'desc';
          let issues = [...repo.issues];
          if (state === 'open' || state === 'closed') {
            issues = issues.filter((issue) => issue.state === state);
          } else if (state === null) {
            // GitHub's default list is open only.
            issues = issues.filter((issue) => issue.state === 'open');
          }
          // state=all -> no filter.
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          } else {
            issues.sort((a, b) => b.createdSeq - a.createdSeq);
          }
          const perPage = Math.max(1, Number.parseInt(search.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1);
          const start = (page - 1) * perPage;
          // Join the cached per-issue JSON texts instead of re-stringifying objects.
          const pageIssues = issues.slice(start, start + perPage);
          const text = `[${pageIssues.map((issue) => issueJsonText(repo, issue).text).join(',')}]`;
          sendJsonText(res, 200, text);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issueNumber = Number.parseInt(tail[1] as string, 10);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      if (tail.length === 2) {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          const serialized = issueJsonText(repo, issue);
          sendJsonText(res, 200, serialized.text, serialized.byteLength);
          return true;
        }
        if (method === 'PATCH') {
          const state = asString(json.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(json.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(json.body);
          if (bodyText !== undefined) issue.body = bodyText;
          issue.jsonCache = null;
          const serialized = issueJsonText(repo, issue);
          sendJsonText(res, 200, serialized.text, serialized.byteLength);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'POST') {
          const bodyText = asString(json.body);
          if (bodyText === undefined) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          const comment = store.addComment(issue, bodyText);
          issue.jsonCache = null; // comments count changed
          sendJson(res, 201, commentJson(comment));
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(comment)));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // ---- pulls -----------------------------------------------------------
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const head = asString(json.head);
          const base = asString(json.base);
          const title = asString(json.title);
          if (head === undefined || base === undefined || title === undefined) {
            sendError(res, 422, 'Validation Failed');
            return true;
          }
          const bodyText = asString(json.body) ?? '';
          const headSha = refTip(repo, branchRef(head));
          const baseSha = refTip(repo, branchRef(base));
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, 422, 'Validation Failed: head or base branch does not exist.');
            return true;
          }
          const pull = store.createPull(repo, title, bodyText, head, base, headSha, baseSha);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (method === 'GET') {
          const state = search.get('state');
          let pulls = [...repo.pulls];
          if (state === 'all') {
            // no filter
          } else if (state === 'closed') {
            pulls = pulls.filter((pull) => pull.state === 'closed');
          } else {
            // Default (and state=open): open only.
            pulls = pulls.filter((pull) => pull.state === 'open');
          }
          pulls.sort((a, b) => b.createdSeq - a.createdSeq);
          const perPage = Math.max(1, Number.parseInt(search.get('per_page') ?? '30', 10) || 30);
          const page = Math.max(1, Number.parseInt(search.get('page') ?? '1', 10) || 1);
          const start = (page - 1) * perPage;
          sendJson(res, 200, pulls.slice(start, start + perPage).map((pull) => pullJson(repo, pull)));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pullNumber = Number.parseInt(tail[1] as string, 10);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (tail.length === 2) {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const headTip = refTip(repo, branchRef(pull.head)) ?? pull.headSha;
        const baseTip = refTip(repo, branchRef(pull.base)) ?? pull.baseSha;
        const base = mergeBase(repo.objects, headTip, baseTip);
        const baseTree = base === undefined ? undefined : commitTree(repo.objects, base);
        const headTree = commitTree(repo.objects, headTip);
        const changes = headTree === undefined ? [] : diffTrees(repo.objects, baseTree, headTree);
        sendJson(
          res,
          200,
          changes.map((change) => ({
            filename: change.path,
            status: change.status,
            additions: change.additions,
            deletions: change.deletions,
            changes: change.additions + change.deletions,
            sha: '',
          })),
        );
        return true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, 405, 'Pull Request is not mergeable');
          return true;
        }
        const result = squashMerge(repo, pull.head, pull.base, pull.number);
        if (!result.ok) {
          sendError(res, 405, 'Pull Request is not mergeable');
          return true;
        }
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = new Date().toISOString();
        pull.mergeCommitSha = result.commitSha;
        sendJson(res, 200, {
          merged: true,
          sha: result.commitSha,
          message: 'Pull request successfully merged',
        });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  // Any other /api/v3 route: JSON 404.
  sendError(res, 404, 'Not Found');
  return true;
}
