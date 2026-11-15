// pkt-line framing for the git smart-HTTP protocols (protocol v0 and v2).
// A pkt-line is a 4-hex-digit length (including the 4 length bytes) followed by payload.
// "0000" is a flush packet, "0001" is a delimiter packet (v2), "0002" is a response-end (v2).

export const FLUSH = '0000';
export const DELIM = '0001';
export const RESPONSE_END = '0002';

/** Encode one pkt-line. `line` must not contain a trailing newline unless intended. */
export function pktLine(line: string): Buffer {
  const payload = Buffer.from(line, 'utf8');
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

/** Encode a flush packet. */
export function pktFlush(): Buffer {
  return Buffer.from(FLUSH, 'ascii');
}

/** Encode a delimiter packet (v2). */
export function pktDelim(): Buffer {
  return Buffer.from(DELIM, 'ascii');
}

/** Encode a response-end packet (v2). */
export function pktResponseEnd(): Buffer {
  return Buffer.from(RESPONSE_END, 'ascii');
}

/** Concatenate pkt-lines for a list of lines, each terminated with '\n' unless already. */
export function pktLines(lines: readonly string[]): Buffer {
  return Buffer.concat(lines.map((l) => pktLine(l.endsWith('\n') ? l : `${l}\n`)));
}

/** A parsed pkt-line stream: lines (without trailing newline), flush/delim markers. */
export type PktItem =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * Parse a buffer of pkt-lines. Stops at `end` bytes consumed; returns the items and how
 * many bytes were consumed. Throws on a malformed length. A trailing partial packet is
 * left unconsumed (caller may have more data coming, e.g. a packfile follows).
 */
export function parsePktLines(buf: Buffer, start = 0): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('ascii', off, off + 4);
    if (hex === FLUSH) {
      items.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (hex === DELIM) {
      items.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (hex === RESPONSE_END) {
      items.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    const text = buf.toString('utf8', off + 4, off + len);
    items.push({ kind: 'line', text: text.endsWith('\n') ? text.slice(0, -1) : text });
    off += len;
  }
  return { items, consumed: off - start };
}

/**
 * Parse a full request body of pkt-lines into the lines before the first flush,
 * plus the byte offset where the flush packet ended (a packfile may follow there).
 */
export function splitPktAndRest(buf: Buffer): { lines: string[]; restOffset: number } {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('ascii', off, off + 4);
    if (hex === FLUSH) {
      off += 4;
      return { lines, restOffset: off };
    }
    if (hex === DELIM || hex === RESPONSE_END) {
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) break;
    const text = buf.toString('utf8', off + 4, off + len);
    lines.push(text.endsWith('\n') ? text.slice(0, -1) : text);
    off += len;
  }
  return { lines, restOffset: off };
}
