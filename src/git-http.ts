// Git smart HTTP at /<owner>/<repo>.git: info/refs (v2 + v0 advertisements), git-upload-pack
// (v2 ls-refs + fetch, v0 fetch fallback), git-receive-pack (v0 push). Implements the contract
// in spec-git.md: exact content types, pkt-line framing (never a packet over 65520 bytes),
// sideband-framed packs and push reports, fast-forward enforcement with the exact
// `non-fast-forward` reason, shallow/deepen semantics, 404 for a missing repo.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type ObjectStore,
} from './git-objects.ts';
import { readPack, writePack } from './git-pack.ts';
import { pktDelim, pktFlush, pktLine, pktLines, parsePktLines, splitPktAndRest } from './git-pktline.ts';
import { VIEWER, type ForgeStore, type Repo } from './store.ts';
import { nextRequestId } from './http-utils.ts';

const UPLOAD_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Max sideband band-data bytes per pkt-line: 65520 total - 4 header - 1 band byte. */
const SIDEBAND_CHUNK = 65515;

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendGit404(res: ServerResponse): void {
  const body = Buffer.from('Not Found\n', 'utf8');
  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendGit400(res: ServerResponse, message: string): void {
  const body = Buffer.from(`${message}\n`, 'utf8');
  res.writeHead(400, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

// ---------------------------------------------------------------- refs

/** All refs of a repo, sorted by name (HEAD handled separately by callers). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The oid a tag ref peels to (following tag chains to a non-tag object), or undefined. */
function peelRef(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  const peeled = peelToCommit(repo.objects, oid);
  return peeled ?? undefined;
}

// ---------------------------------------------------------------- advertisements

/** v2 capability advertisement (upload-pack, Git-Protocol: version=2). Constant bytes: the
 * v2 advertisement carries no refs, so it is built once and reused for every request. */
const ADVERTISE_V2: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('fetch=shallow\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('object-format=sha1\n'),
  pktFlush(),
]);

function advertiseV2(): Buffer {
  return ADVERTISE_V2;
}

/**
 * v0 ref advertisement (upload-pack without the v2 header, or receive-pack).
 * First line is the `# service=...` preamble + flush, then ref lines; the first ref line
 * carries the capabilities after a NUL. An empty repo gets the `capabilities^{}` pseudo-ref.
 */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs symref=HEAD:refs/heads/main'
      : 'side-band-64k shallow symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    // HEAD first (when main exists), carrying the capabilities.
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      const suffix = first ? `\0${caps}` : '';
      first = false;
      parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
      const peeled = peelRef(repo, oid);
      if (peeled !== undefined) {
        parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- ls-refs (v2)

/** Handle a v2 ls-refs command body (the pkt-lines after `command=ls-refs`). */
function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    // agent= / object-format= lines are accepted and ignored.
  }
  const out: string[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));

  // HEAD line: only when no prefix filter is active (HEAD matches no refs/ prefix).
  if (prefixes.length === 0 && symrefs) {
    if (mainTip !== undefined) {
      out.push(`${mainTip} HEAD symref-target:refs/heads/main`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:refs/heads/main`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelRef(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    out.push(line);
  }
  return Buffer.concat([pktLines(out), pktFlush()]);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | undefined;
}

/** Parse the pkt-lines of a v2 fetch command (after `command=fetch` + delim). */
function parseFetchV2(lines: string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
    // thin-pack, no-progress, ofs-delta, done, agent=, object-format=, filter: ignored.
  }
  return { wants, haves, shallow, deepen };
}

/** The tree/blob closure of one commit (its tree, subtrees and blobs) — parents NOT followed. */
function treeClosure(store: ObjectStore, commitOid: string, out: Set<string>): void {
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return;
  const treeOid = parseCommit(commit.data).tree;
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = store.get(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    }
  }
}

/**
 * Compute the fetch result: the objects to pack, the new shallow boundary, and the commits
 * that stop being shallow. Rules (spec §2.4):
 * - Include commits up to `deepen` generations from each want (unbounded when no deepen);
 *   traversal stops at haves (everything reachable from a have is excluded anyway) and at
 *   the depth boundary (boundary commits are reported `shallow`, parents not traversed).
 * - The pack holds the included commits + their tree/blob closures, minus everything
 *   reachable from the haves.
 * - A request-shallow commit whose parent is delivered becomes `unshallow`.
 */
function computeFetch(
  store: ObjectStore,
  req: FetchRequest,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const haves = new Set(req.haves);
  // Exclusion: everything reachable from the haves — EXCEPT that a shallow boundary
  // commit's parents are NOT held by the client (that is what "shallow" means), so the
  // walk stops at the request's shallow commits. Their own trees/blobs ARE held, so
  // they stay excluded. Without this, a deepen fetch would exclude the very parent it
  // is asked to deliver (the parent is reachable from the shallow have).
  const shallowSet = new Set(req.shallow);
  const excluded = new Set<string>();
  {
    const { commits, trees, blobs } = collectReachable(store, [...haves], shallowSet);
    for (const oid of commits) excluded.add(oid);
    for (const oid of trees) excluded.add(oid);
    for (const oid of blobs) excluded.add(oid);
    for (const oid of shallowSet) {
      if (!haves.has(oid)) continue;
      const obj = store.get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        excluded.add(oid);
        const peeled = peelToCommit(store, oid);
        if (peeled !== null) {
          excluded.add(peeled);
          treeClosure(store, peeled, excluded);
        }
      } else if (obj.type === 'commit') {
        excluded.add(oid);
        treeClosure(store, oid, excluded);
      }
    }
  }

  // Peel tag wants to their target commits; tag objects themselves go straight in the pack.
  const tagObjects = new Set<string>();
  const wantCommits: string[] = [];
  for (const want of req.wants) {
    const obj = store.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.add(want);
      const peeled = peelToCommit(store, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
    // Blob/tree wants are not sent by the client; ignore them.
  }

  // BFS over commits by generation (want = generation 1).
  const includedCommits = new Set<string>();
  const shallow = new Set<string>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 1]);
  const seen = new Set<string>();
  while (queue.length > 0) {
    const [oid, generation] = queue.shift() as [string, number];
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    // Stop at the depth boundary: the commit is shallow, its parents are not traversed.
    if (req.deepen !== undefined && generation >= req.deepen) {
      shallow.add(oid);
      continue;
    }
    // Stop at haves — but only for unbounded fetches: everything below a have is excluded
    // anyway. For a deepen fetch the parents of a have ARE wanted (that is what deepen
    // means: the client holds the tip and asks for the generation below it), so traversal
    // continues through haves when a depth limit is in force.
    if (req.deepen === undefined && haves.has(oid)) continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!seen.has(parent)) queue.push([parent, generation + 1]);
    }
  }

  // Assemble the pack set: tag objects + included commits + their tree closures, minus haves.
  const packSet = new Set<string>();
  for (const oid of tagObjects) packSet.add(oid);
  for (const oid of includedCommits) packSet.add(oid);
  for (const oid of includedCommits) treeClosure(store, oid, packSet);
  for (const oid of excluded) packSet.delete(oid);

  const objects = new Map<string, GitObject>();
  for (const oid of packSet) {
    const obj = store.get(oid);
    if (obj !== undefined) objects.set(oid, obj);
  }

  // Unshallow: a request-shallow commit whose parent was delivered in this fetch.
  const unshallow: string[] = [];
  for (const oid of req.shallow) {
    if (shallow.has(oid)) continue; // still on the boundary
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => includedCommits.has(p) && !excluded.has(p))) {
      unshallow.push(oid);
    }
  }

  return { objects, shallow: [...shallow], unshallow };
}

/** Encode pack bytes as band-1 sideband pkt-lines (≤65515 band bytes each). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(off, Math.min(off + SIDEBAND_CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const head = Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
    parts.push(Buffer.concat([head, payload]));
  }
  return Buffer.concat(parts);
}

/** Build the v2 fetch response for a computed fetch. */
function fetchResponseV2(store: ObjectStore, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(store, req);
  const parts: Buffer[] = [];

  // acknowledgments: ACK every recognised have (+ ready), else NAK.
  parts.push(pktLine('acknowledgments\n'));
  const recognised = req.haves.filter((have) => store.get(have) !== undefined);
  if (recognised.length > 0) {
    for (const have of recognised) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());

  // shallow-info: only when there is boundary news.
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }

  // packfile: omit the section entirely when nothing is owed.
  if (objects.size > 0) {
    const entries: Array<readonly [string, GitObject['type'], Buffer]> = [];
    for (const [oid, obj] of objects) entries.push([oid, obj.type, obj.data]);
    const pack = writePack(entries);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
  }

  return Buffer.concat(parts);
}

/** Build the v0 fetch response (fallback path): shallow lines, NAK/ACK, sideband pack. */
function fetchResponseV0(store: ObjectStore, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(store, req);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const recognised = req.haves.filter((have) => store.get(have) !== undefined);
  if (recognised.length > 0) {
    for (const have of recognised) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (objects.size > 0) {
    const entries: Array<readonly [string, GitObject['type'], Buffer]> = [];
    for (const [oid, obj] of objects) entries.push([oid, obj.type, obj.data]);
    parts.push(sidebandPack(writePack(entries)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the command list of a receive-pack request (lines before the first flush). */
function parsePushCommands(lines: string[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const line of lines) {
    // The first command may carry capabilities after a NUL byte.
    const nul = line.indexOf('\0');
    const command = nul === -1 ? line : line.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(command);
    if (match === null) continue; // malformed lines are skipped, never crash
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  return commands;
}

/**
 * Apply push commands to a repo. Returns one report line per command, in order.
 * Unpack (done by the caller) and ref verdicts are independent: a refused update still
 * unpacks, and one command's refusal never blocks another's application.
 */
function applyPushCommands(repo: Repo, commands: PushCommand[]): string[] {
  const report: string[] = [];
  for (const { oldOid, newOid, ref } of commands) {
    const current = repo.refs.get(ref);
    if (newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        report.push(`ng ${ref} ref does not exist`);
      } else if (current !== oldOid) {
        report.push(`ng ${ref} old value does not match`);
      } else {
        repo.refs.delete(ref);
        report.push(`ok ${ref}`);
      }
      continue;
    }
    if (oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        report.push(`ng ${ref} ref already exists`);
        continue;
      }
      if (repo.objects.get(newOid) === undefined) {
        report.push(`ng ${ref} new object does not exist`);
        continue;
      }
      repo.refs.set(ref, newOid);
      report.push(`ok ${ref}`);
      continue;
    }
    // Update.
    if (current === undefined) {
      report.push(`ng ${ref} ref does not exist`);
      continue;
    }
    if (current !== oldOid) {
      report.push(`ng ${ref} old value does not match`);
      continue;
    }
    if (repo.objects.get(newOid) === undefined) {
      report.push(`ng ${ref} new object does not exist`);
      continue;
    }
    if (newOid === oldOid || isAncestor(repo.objects, oldOid, newOid)) {
      repo.refs.set(ref, newOid);
      report.push(`ok ${ref}`);
    } else {
      // The reason string is exact: checks compare it verbatim.
      report.push(`ng ${ref} non-fast-forward`);
    }
  }
  return report;
}

/** The push report stream (pkt-line framed) wrapped in band-1 sideband packets + top flush. */
function pushReportResponse(unpackOk: boolean, unpackDetail: string, reportLines: string[]): Buffer {
  const stream = Buffer.concat([
    pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`),
    pktLines(reportLines),
    pktFlush(),
  ]);
  return Buffer.concat([sidebandPack(stream), pktFlush()]);
}

// ---------------------------------------------------------------- router

/**
 * Handle a git smart-HTTP request. Returns true when the path matched a git route
 * (handled, even as a 404); false when the path is not a git route at all.
 */
export function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  store: ForgeStore,
): boolean {
  let pathname = '/';
  let search = new URLSearchParams();
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    pathname = url.pathname;
    search = url.searchParams;
  } catch {
    return false;
  }
  // /<owner>/<repo>.git/<endpoint>
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const endpoint = match[3] as string;
  const method = req.method ?? 'GET';

  const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    sendGit404(res);
    return true;
  }

  try {
    // ---- info/refs -------------------------------------------------------
    if (endpoint === 'info/refs' && method === 'GET') {
      const service = search.get('service');
      if (service === 'git-upload-pack') {
        if (req.headers['git-protocol'] === 'version=2') {
          sendGit(res, 200, UPLOAD_ADVERTISEMENT, advertiseV2());
        } else {
          sendGit(res, 200, UPLOAD_ADVERTISEMENT, advertiseV0(repo, 'git-upload-pack'));
        }
        return true;
      }
      if (service === 'git-receive-pack') {
        sendGit(res, 200, RECEIVE_ADVERTISEMENT, advertiseV0(repo, 'git-receive-pack'));
        return true;
      }
      sendGit404(res);
      return true;
    }

    // ---- git-upload-pack -------------------------------------------------
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      const { items } = parsePktLines(rawBody);
      const lines: string[] = [];
      for (const item of items) {
        if (item.kind === 'line') lines.push(item.text);
      }
      if (lines.length === 0) {
        sendGit400(res, 'expected a pkt-line framed request');
        return true;
      }
      const first = lines[0] as string;
      if (first === 'command=ls-refs') {
        sendGit(res, 200, UPLOAD_RESULT, handleLsRefs(repo, lines.slice(1)));
        return true;
      }
      if (first === 'command=fetch') {
        const req2 = parseFetchV2(lines.slice(1));
        if (req2.wants.length === 0) {
          sendGit400(res, 'fetch requires at least one want');
          return true;
        }
        sendGit(res, 200, UPLOAD_RESULT, fetchResponseV2(repo.objects, req2));
        return true;
      }
      if (first.startsWith('want ')) {
        // v0 fetch: two sections (wants, then haves) split by a flush packet.
        const v0Req = parseFetchV0(items);
        if (v0Req.wants.length === 0) {
          sendGit400(res, 'fetch requires at least one want');
          return true;
        }
        sendGit(res, 200, UPLOAD_RESULT, fetchResponseV0(repo.objects, v0Req));
        return true;
      }
      sendGit400(res, 'unknown upload-pack command');
      return true;
    }

    // ---- git-receive-pack ------------------------------------------------
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      const { lines, restOffset } = splitPktAndRest(rawBody);
      const commands = parsePushCommands(lines);
      if (commands.length === 0) {
        sendGit400(res, 'expected at least one ref command');
        return true;
      }
      // Unpack the pack (if any bytes follow the command-list flush).
      let unpackOk = true;
      let unpackDetail = 'ok';
      const packBytes = rawBody.subarray(restOffset);
      if (packBytes.length > 0) {
        try {
          const objects = readPack(packBytes, repo.objects);
          for (const [oid, obj] of objects) repo.objects.putKnown(oid, obj.type, obj.data);
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'pack error';
        }
      }
      const report = unpackOk
        ? applyPushCommands(repo, commands)
        : commands.map((c) => `ng ${c.ref} unpack failed`);
      sendGit(res, 200, RECEIVE_RESULT, pushReportResponse(unpackOk, unpackDetail, report));
      return true;
    }

    sendGit404(res);
    return true;
  } catch {
    // Never crash or hang on a malformed request: answer 400 and keep serving.
    if (!res.headersSent) sendGit400(res, 'bad request');
    return true;
  }
}

/** Parse a v0 fetch request body (want lines, flush, have lines, done, flush). */
function parseFetchV0(items: ReadonlyArray<{ kind: string; text?: string }>): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | undefined;
  for (const item of items) {
    if (item.kind !== 'line' || item.text === undefined) continue;
    const line = item.text;
    if (line.startsWith('want ')) {
      // The first want line carries capabilities after the oid; take the first token.
      wants.push(line.slice(5).split(' ')[0] as string);
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    } else if (line.startsWith('shallow ')) {
      shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
  }
  return { wants, haves, shallow, deepen };
}

// Re-exported for tests / callers that need the oid check.
export { isOid };
