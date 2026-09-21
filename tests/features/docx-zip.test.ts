import { describe, it, expect } from 'vitest';
import { crc32 } from 'node:zlib';
import { buildZip, readZip } from '../../src/features/docx/zip.js';

const enc = new TextEncoder();

/**
 * The CRC is the whole point of this file.
 *
 * The zip writer the EPUB fixtures use leaves CRC-32 at zero in both headers, and the
 * reader those fixtures feed never checks it, so an archive with zero CRCs passes every
 * test in this repo and is refused by Word with no useful message. These tests assert the
 * checksum bytes directly rather than round-tripping through a tolerant reader.
 */
describe('docx zip writer', () => {
  it('writes the real CRC-32 in BOTH the local header and the central directory', () => {
    const payload = 'word/document.xml contents, long enough to actually deflate. '.repeat(20);
    const bytes = buildZip([
      { name: 'stored.txt', data: 'stored verbatim', deflate: false },
      { name: 'deflated.xml', data: payload },
    ]);
    const zip = readZip(bytes)!;
    expect(zip).not.toBeNull();

    const stored = zip.entry('stored.txt')!;
    const deflated = zip.entry('deflated.xml')!;
    expect(stored.localCrc).toBe(crc32(enc.encode('stored verbatim')) >>> 0);
    expect(stored.centralCrc).toBe(stored.localCrc);
    expect(deflated.localCrc).toBe(crc32(enc.encode(payload)) >>> 0);
    expect(deflated.centralCrc).toBe(deflated.localCrc);
    // A zero CRC is exactly the bug this guards, so say so rather than only comparing.
    expect(stored.localCrc).not.toBe(0);
    expect(deflated.localCrc).not.toBe(0);
  });

  it('records the compression method and both sizes consistently', () => {
    const payload = 'x'.repeat(5000);
    const zip = readZip(
      buildZip([
        { name: 'a.bin', data: enc.encode(payload), deflate: false },
        { name: 'b.bin', data: enc.encode(payload) },
      ]),
    )!;
    const stored = zip.entry('a.bin')!;
    const deflated = zip.entry('b.bin')!;
    expect(stored.method).toBe(0);
    expect(stored.compressedSize).toBe(stored.uncompressedSize);
    expect(stored.uncompressedSize).toBe(5000);
    expect(deflated.method).toBe(8);
    expect(deflated.uncompressedSize).toBe(5000);
    expect(deflated.compressedSize).toBeLessThan(5000);
  });

  it('reads every entry back byte for byte, in the order written', () => {
    const zip = readZip(
      buildZip([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: '<w:document/>' },
        { name: 'docProps/custom.xml', data: '<Properties/>', deflate: false },
      ]),
    )!;
    expect(zip.names()).toEqual(['[Content_Types].xml', 'word/document.xml', 'docProps/custom.xml']);
    expect(zip.text('word/document.xml')).toBe('<w:document/>');
    expect(zip.text('docProps/custom.xml')).toBe('<Properties/>');
  });

  it('survives non-ASCII entry data without corrupting the byte count', () => {
    const text = 'Ångström, “quoted”, ¶ and §';
    const zip = readZip(buildZip([{ name: 'u.txt', data: text }]))!;
    expect(zip.text('u.txt')).toBe(text);
    expect(zip.entry('u.txt')!.uncompressedSize).toBe(enc.encode(text).length);
    expect(zip.entry('u.txt')!.localCrc).toBe(crc32(enc.encode(text)) >>> 0);
  });

  it('returns null rather than throwing on bytes that are not a zip', () => {
    expect(readZip(enc.encode('not a zip at all'))).toBeNull();
    expect(readZip(new Uint8Array(0))).toBeNull();
  });

  it('returns undefined for an entry the archive does not hold', () => {
    const zip = readZip(buildZip([{ name: 'a.txt', data: 'a' }]))!;
    expect(zip.read('missing.txt')).toBeUndefined();
    expect(zip.text('missing.txt')).toBeUndefined();
    expect(zip.entry('missing.txt')).toBeUndefined();
  });
});
