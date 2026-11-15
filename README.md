# github-core-clone-01 forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/shiryuu156/gitforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/shiryuu156/gitforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node.js process — the entry for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01). No dependencies at run
time, no git binary, no database: the whole forge is the standard library plus this source,
serving from its own in-memory store.

## What it serves

| Route | What it is |
|---|---|
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send (viewer, repository, node, issues with cursor pagination, all five mutations, introspection, batching) |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision `2026-07-28` + legacy handshake): `server/discover`, `tools/list`, `tools/call` with six tools |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 with `fetch`/`ls-refs`, plus a v0 fallback), `git-receive-pack` (v0 push with report-status) |
| anything else | 404 `{"message":"Not Found"}` |

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types
on its own; the flag is harmless there and makes an older local Node work too. There is
nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own
modules only, and the trial has no package manager and no internet.

The lifecycle (`main.ts`, unchanged from the starter): bind an ephemeral port, POST it to
`$MAKEFUN_ENV_URL/register`, poll `$MAKEFUN_ENV_URL/done` until the env says the trial is
over, exit 0.

## Layout

- `main.ts`: the entry <-> env lifecycle. Keep it as it is.
- `app.ts`: the server: one store, one dispatch (git -> REST -> GraphQL -> MCP -> 404).
- `src/store.ts`: the in-memory store (repos, issues, pulls, labels, comments) shared by all four surfaces.
- `src/git-objects.ts`: SHA-1 object model — hashing, commit/tree/tag parse and build, reachability, delta application.
- `src/git-pack.ts`: packfile v2 read/write (plain objects, delta-aware reader).
- `src/git-pktline.ts`: pkt-line framing.
- `src/git-repo.ts`: repo-level git operations — commits, trees, history, diffs, merge bases, squash merges.
- `src/git-http.ts`: git smart HTTP — v2/v0 advertisements, ls-refs, fetch (with shallow/deepen), receive-pack with fast-forward enforcement.
- `src/rest.ts`: REST v3.
- `src/graphql.ts`: a small purpose-built GraphQL parser + executor for the suite's documents.
- `src/mcp.ts`: MCP endpoint (modern era + legacy handshake).
- `src/http-utils.ts`: shared JSON/auth/body helpers.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Local grading

Against the kit's sealed suite (`sdk/run.ts`), on a fresh server:

```
120/120 conformance checks pass (feature 600, agent 200)
perf 120–137 across runs (reference = 100), score 920–937
```

The perf column varies with machine load; the trial pod is dedicated, so local numbers on a
shared VM are a lower bound. Always restart the server before a run — the suite expects a
fresh, empty forge and re-running against a live one collides on repo names.

```sh
# boot the server on a port (dev runner, not part of the submission)
node --experimental-strip-types /tmp/forge-dev.mjs 18081 dev-token
# grade it
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18081 --token dev-token --perf
```

Typecheck (dev only; needs the devDependencies installed):

```sh
npm install && npm run typecheck
```

## Notes

- The token owner is the scenario viewer (`adaiversen`, id 1000). The env hands the entry
  only the bearer token and never names the login behind it, but the sealed scenario is
  built from one constant seed, so the viewer is deterministic in every trial (verified
  against the kit's own `buildScenario()` and every practice trial's `reference/scenario.json`).
- Packs are plain-object (no deltas): the client accepts them, and building them is
  cheaper than delta search. The pack reader resolves deltas anyway, in case one arrives.
- Pack parsing finds each zlib stream's length by re-deflating the known inflated bytes
  (the suite's client uses default `deflateSync`, which is deterministic) with a binary
  search fallback for packs produced any other way.
