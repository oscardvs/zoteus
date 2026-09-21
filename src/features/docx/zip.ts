import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * A zip writer and reader for the .docx emitter.
 *
 * The repo already settled the "do not add an archive dependency" question for EPUB
 * reading (src/features/fulltext/epub.ts): the zip subset an office document uses is
 * stored and deflated entries, no encryption, no zip64, and node:zlib already does both
 * halves. A .docx is the same subset, so this is that same reasoning applied to writing.
 *
 * The one thing that differs from the EPUB reader is CRC-32. That reader never validates
 * it, because nothing it reads was written here. Word does validate it, and an archive
 * whose CRCs are zero opens fine in a tolerant reader and is refused by Word, so the
 * writer below fills both copies (local header and central directory) and the reader below
 * checks them. Checking is what makes the tests able to catch the failure at all.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** The end-of-central-directory record plus the largest comment that can follow it. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

export interface ZipEntryInput {
  /** Path inside the archive, e.g. `word/document.xml`. Always forward slashes. */
  name: string;
  data: string | Uint8Array;
  /** Deflate the entry (the default); false stores it verbatim. */
  deflate?: boolean;
}

/**
 * A zip archive holding exactly these entries, in this order, with correct CRC-32s.
 *
 * Offsets are written by hand rather than through a library: local header CRC at +14,
 * central directory CRC at +16. Both must carry the checksum of the UNCOMPRESSED bytes.
 */
export function buildZip(files: ZipEntryInput[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const raw = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
    const deflate = file.deflate ?? true;
    const body = deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const method = deflate ? 8 : 0;
    // crc32 returns a signed-safe unsigned value; setUint32 truncates the same way either
    // way, but >>> 0 keeps the intent obvious.
    const sum = crc32(raw) >>> 0;

    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIGNATURE, true);
    lv.setUint16(4, 20, true); // version needed to extract: 2.0 (deflate)
    lv.setUint16(8, method, true);
    lv.setUint32(14, sum, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    locals.push(local);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, CENTRAL_SIGNATURE, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed to extract
    cv.setUint16(10, method, true);
    cv.setUint32(16, sum, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    offset += local.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIGNATURE, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let at = 0;
  for (const part of [...locals, ...central, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export interface ZipEntryView {
  name: string;
  method: number;
  /** CRC-32 as recorded in the local header. */
  localCrc: number;
  /** CRC-32 as recorded in the central directory. */
  centralCrc: number;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipArchiveView {
  names(): string[];
  entry(name: string): ZipEntryView | undefined;
  /** Uncompressed bytes, or undefined when the entry is absent or unreadable. */
  read(name: string): Uint8Array | undefined;
  /** Uncompressed bytes decoded as UTF-8. */
  text(name: string): string | undefined;
}

/**
 * Index a zip archive from its central directory. Unlike the EPUB reader this one keeps
 * both CRC copies so a caller (the tests) can prove they were written and agree with the
 * data, which is the specific failure that would otherwise ship silently.
 */
export function readZip(bytes: Uint8Array): ZipArchiveView | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff) return null; // zip64, which nothing here writes

  const entries = new Map<string, ZipEntryView & { localHeaderOffset: number }>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = dec.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const localCrc =
      localHeaderOffset + 30 <= bytes.byteLength &&
      view.getUint32(localHeaderOffset, true) === LOCAL_SIGNATURE
        ? view.getUint32(localHeaderOffset + 14, true)
        : 0;
    entries.set(name, {
      name,
      method: view.getUint16(offset + 10, true),
      centralCrc: view.getUint32(offset + 16, true),
      localCrc,
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!entries.size) return null;

  const read = (name: string): Uint8Array | undefined => {
    const entry = entries.get(name);
    if (!entry) return undefined;
    const start = entry.localHeaderOffset;
    if (start + 30 > bytes.byteLength || view.getUint32(start, true) !== LOCAL_SIGNATURE) return undefined;
    const dataStart = start + 30 + view.getUint16(start + 26, true) + view.getUint16(start + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.byteLength) return undefined;
    const raw = bytes.subarray(dataStart, dataEnd);
    if (entry.method === 0) return raw;
    if (entry.method !== 8) return undefined;
    try {
      return new Uint8Array(inflateRawSync(raw));
    } catch {
      return undefined;
    }
  };

  return {
    names: () => [...entries.keys()],
    entry: (name) => entries.get(name),
    read,
    text: (name) => {
      const bytesOut = read(name);
      return bytesOut === undefined ? undefined : dec.decode(bytesOut);
    },
  };
}

function findEocd(view: DataView, length: number): number {
  const floor = Math.max(0, length - MAX_EOCD_SEARCH);
  for (let i = length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i;
  }
  return -1;
}
