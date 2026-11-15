// Packfile reading and writing (pack v2). The suite's client writes plain objects only
// (no deltas) for pushes, and reads packs with full delta support — so this writer emits
// plain deflated objects (fast, no delta search) and the reader resolves deltas too,
// in case a pack ever carries them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { applyDeltaTo, hashObject, type GitObject, type GitObjectType, type ObjectStore } from './git-objects.ts';

const TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Pack entry header: type + size varint. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = TYPE_NUM[type];
  const bytes: number[] = [];
  let n = size;
  let first = (typeNum << 4) | (n & 0x0f);
  n >>= 4;
  if (n > 0) first |= 0x80;
  bytes.push(first);
  while (n > 0) {
    let b = n & 0x7f;
    n >>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Build a pack v2 from objects (plain entries, zlib-deflated, no deltas).
 * `objects` is [oid, type, data] in the order they should appear.
 */
export function writePack(objects: readonly (readonly [string, GitObjectType, Buffer])[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const [, type, data] of objects) {
    parts.push(packObjectHeader(type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** One parsed pack entry before delta resolution. */
interface RawEntry {
  readonly offset: number;
  readonly type: GitObjectType | 'ofs-delta' | 'ref-delta';
  readonly size: number;
  readonly data: Buffer; // inflated payload (delta instructions for delta entries)
  readonly baseOffset?: number; // ofs-delta: negative offset to base entry
  readonly baseOid?: string; // ref-delta: base object id
}

/** Read the size varint of a pack entry header; returns [size, bytesConsumed]. */
function readSizeVarint(buf: Buffer, off: number): [number, number] {
  let size = buf[off] & 0x0f;
  let shift = 4;
  let consumed = 1;
  let b = buf[off];
  while ((b & 0x80) !== 0) {
    b = buf[off + consumed];
    size |= (b & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return [size, consumed];
}

/**
 * Parse a packfile buffer into resolved objects. Returns a Map of oid -> {type, data}.
 * Handles plain entries and OFS_DELTA / REF_DELTA (base may be in the pack or in `store`).
 * Throws on malformed input.
 */
export function readPack(pack: Buffer, store?: ObjectStore): Map<string, GitObject> {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  // Verify the pack checksum (cheap, catches corruption early).
  const sum = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!sum.equals(pack.subarray(trailerStart))) throw new Error('pack checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const typeNum = (pack[off] >> 4) & 0x07;
    const [size, sizeLen] = readSizeVarint(pack, off);
    off += sizeLen;
    // The last entry's deflated stream ends exactly at the trailer, so its
    // length is known without re-deflating — that skips one deflate per pack,
    // a third of the deflate work in the push workload's 3-entry packs.
    // (inflateSync already throws if the stream is truncated, so a malformed
    // pack still fails here.)
    const isLast = i === count - 1;
    const entryLength = (inflated: Buffer): number => (isLast ? trailerStart - off : deflatedLength(pack, off, inflated));
    let entry: RawEntry;
    if (typeNum === 6) {
      // OFS_DELTA: base offset encoded as a negative offset varint.
      let b = pack[off];
      let baseOff = b & 0x7f;
      off += 1;
      while ((b & 0x80) !== 0) {
        b = pack[off];
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
        off += 1;
      }
      const inflated = inflateSync(pack.subarray(off));
      entry = { offset: entryOffset, type: 'ofs-delta', size, data: inflated, baseOffset: entryOffset - baseOff };
      off += entryLength(inflated);
    } else if (typeNum === 7) {
      const baseOid = pack.toString('hex', off, off + 20);
      off += 20;
      const inflated = inflateSync(pack.subarray(off));
      entry = { offset: entryOffset, type: 'ref-delta', size, data: inflated, baseOid };
      off += entryLength(inflated);
    } else {
      const type = NUM_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const inflated = inflateSync(pack.subarray(off));
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      entry = { offset: entryOffset, type, size, data: inflated };
      off += entryLength(inflated);
    }
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  // Resolve entries (deltas may chain; resolve iteratively).
  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, { oid: string; type: GitObjectType; data: Buffer }>();
  const pending = new Set(raw);
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const entry of [...pending]) {
      if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
        const oid = hashObject(entry.type, entry.data);
        resolved.set(oid, { type: entry.type, data: entry.data });
        resolvedByOffset.set(entry.offset, { oid, type: entry.type, data: entry.data });
        pending.delete(entry);
        progress = true;
        continue;
      }
      let base: { type: GitObjectType; data: Buffer } | undefined;
      if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) {
        base = resolvedByOffset.get(entry.baseOffset);
      } else if (entry.type === 'ref-delta' && entry.baseOid !== undefined) {
        const fromPack = resolved.get(entry.baseOid);
        base = fromPack ?? store?.get(entry.baseOid);
      }
      if (base === undefined) continue;
      const data = applyDeltaTo(base.data, entry.data);
      const oid = hashObject(base.type, data);
      resolved.set(oid, { type: base.type, data });
      resolvedByOffset.set(entry.offset, { oid, type: base.type, data });
      pending.delete(entry);
      progress = true;
    }
  }
  if (pending.size > 0) throw new Error('pack has unresolvable deltas');
  return resolved;
}

/**
 * How many bytes the zlib stream starting at `off` consumes. Fast path: the suite's client
 * writes packs with default `deflateSync`, which is deterministic — re-deflating the known
 * inflated bytes reproduces the exact stream, so a byte comparison gives the length with one
 * deflate instead of ~10 trial inflates. Falls back to a binary search for packs produced
 * any other way (any deflate level/strategy still resolves correctly, just slower).
 */
function deflatedLength(pack: Buffer, off: number, inflated: Buffer): number {
  const reDeflated = deflateSync(inflated);
  if (off + reDeflated.length <= pack.length - 20) {
    // The trailer is the last 20 bytes; a stream must end before it.
    if (pack.subarray(off, off + reDeflated.length).equals(reDeflated)) return reDeflated.length;
  }
  // Fallback: binary-search the smallest end such that inflateSync succeeds on pack[off:end].
  // inflateSync ignores trailing bytes after a complete stream and throws on truncation, so
  // the minimal working end is exactly the stream end.
  let lo = off + 2;
  let hi = pack.length - 20; // never into the trailer
  let end = Math.min(off + 16, hi);
  while (end <= hi) {
    try {
      inflateSync(pack.subarray(off, end));
      break;
    } catch {
      // Need more bytes (or the stream is corrupt).
    }
    if (end === hi) throw new Error('truncated zlib stream in pack');
    end = Math.min(hi, end * 2);
  }
  let low = lo;
  let high = end;
  while (low < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(pack.subarray(off, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low - off;
}
