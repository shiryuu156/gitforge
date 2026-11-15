// Git object model: hashing, storage, and parsing of blobs, trees, commits and tags.
// All objects live in memory as raw (uncompressed) buffers, keyed by their SHA-1 hex id.
// No git binary: hashing is node:crypto, compression is node:zlib (in git-pack.ts).

import { createHash } from 'node:crypto';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Is `s` a 40-hex object id? */
export function isOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

/** SHA-1 of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** One stored object: its type and raw content. */
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

/** In-memory object database for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store `data` as `type`, return its id. Idempotent. */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id is already known (from a pack). */
  putKnown(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string; // e.g. '100644', '40000', '100755', '120000'
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's raw bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const mode = data.toString('ascii', off, space);
    const nul = data.indexOf(0, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (sorted git-style: names with '/' appended for dirs). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string; // raw "Name <email> ts tz" line content
  readonly committer: string;
  readonly message: string;
  readonly gpgsig?: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse an ident line "Name <email> ts tz" into parts. */
export function parseIdent(line: string): { name: string; email: string; epochSec: number; tz: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: '', epochSec: 0, tz: '+0000' };
  return { name: m[1] ?? '', email: m[2] ?? '', epochSec: Number(m[3]), tz: m[4] ?? '+0000' };
}

/** Build a commit object's raw bytes. */
export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** Format an ident line. */
export function identLine(name: string, email: string, epochSec: number, tz = '+0000'): string {
  return `${name} <${email}> ${epochSec} ${tz}`;
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object's raw bytes. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const message = headEnd === -1 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- deltas

/**
 * Apply a git delta (copy/insert instruction stream) to a base object's bytes.
 * Delta format: varint source size, varint target size, then opcodes:
 * - 0x80|... : copy from base (offset/size bitfields follow)
 * - 0x00<opcode<0x80 : insert that many literal bytes
 * - 0x00 : invalid
 */
export function applyDeltaTo(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const b = delta[off++] as number;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (off >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= (delta[off++] as number) << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (off >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= (delta[off++] as number) << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (off + op > delta.length) throw new Error('delta insert is truncated');
      if (written + op > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, off, off + op);
      off += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------- reachability

/**
 * Walk commits reachable from `tips` (following parents), collecting every commit oid
 * and every tree/blob oid reachable from those commits' trees. `stopAt` oids are not
 * traversed past (used for have-based negotiation). Returns oids in a stable order:
 * commits first (newest-first by walk order), then trees, then blobs.
 */
export function collectReachable(
  store: ObjectStore,
  tips: readonly string[],
  stopAt: ReadonlySet<string> = new Set(),
): { commits: string[]; trees: string[]; blobs: string[] } {
  const commits: string[] = [];
  const trees: string[] = [];
  const blobs: string[] = [];
  const seenCommit = new Set<string>();
  const seenTree = new Set<string>();
  const seenBlob = new Set<string>();
  const commitQueue: string[] = [...tips];
  const treeQueue: string[] = [];
  while (commitQueue.length > 0) {
    const oid = commitQueue.pop() as string;
    if (seenCommit.has(oid) || stopAt.has(oid)) continue;
    seenCommit.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    commits.push(oid);
    const info = parseCommit(obj.data);
    treeQueue.push(info.tree);
    for (const p of info.parents) commitQueue.push(p);
  }
  while (treeQueue.length > 0) {
    const oid = treeQueue.pop() as string;
    if (seenTree.has(oid)) continue;
    seenTree.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'tree') continue;
    trees.push(oid);
    for (const e of parseTree(obj.data)) {
      if (e.mode === '40000') treeQueue.push(e.oid);
      else if (!seenBlob.has(e.oid)) {
        seenBlob.add(e.oid);
        blobs.push(e.oid);
      }
    }
  }
  return { commits, trees, blobs };
}

/** Is `ancestor` reachable from `tip` (following parents)? Includes equality. */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const info = parseCommit(obj.data);
    for (const p of info.parents) {
      if (p === ancestor) return true;
      queue.push(p);
    }
  }
  return false;
}

/** Resolve a ref to a commit oid, peeling annotated tags. Returns null when unresolvable. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = store.get(cur);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}
