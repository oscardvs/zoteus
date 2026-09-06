// tests/lib/logger.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from '../../src/lib/logger.js';

// Return type inferred: vi.spyOn's MockInstance is keyed to the spied signature and does not
// widen to the bare `ReturnType<typeof vi.spyOn>` this used to claim.
function capture() {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => {
    lines.push(String(c));
    return true;
  });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    lines,
    outSpy,
    restore: () => {
      spy.mockRestore();
      outSpy.mockRestore();
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe('logger', () => {
  it('text format redacts object args', () => {
    const { lines, outSpy, restore } = capture();
    createLogger('info', 'text').info('issued', { token: 'abc', clientId: 'c1' });
    restore();
    expect(lines.join('')).toContain('[zoteus] INFO');
    expect(lines.join('')).toContain('"token":"[REDACTED]"');
    expect(lines.join('')).toContain('"clientId":"c1"');
    expect(lines.join('')).not.toContain('abc');
    expect(outSpy).not.toHaveBeenCalled();
  });
  it('json format emits one parseable object per line with level/msg', () => {
    const { lines, outSpy, restore } = capture();
    createLogger('info', 'json').warn('careful', { apiKey: 'zzz' });
    restore();
    const obj = JSON.parse(lines.join('').trim());
    expect(obj.level).toBe('warn');
    expect(obj.msg).toBe('careful');
    // The trailing object is spread into the record, so its keys are queryable; redaction
    // has already run by then, so the value is masked in place rather than dropped.
    expect(obj.apiKey).toBe('[REDACTED]');
    expect(lines.join('')).not.toContain('zzz');
    expect(typeof obj.time).toBe('string');
    expect(outSpy).not.toHaveBeenCalled();
  });
  it('json format keeps reserved keys and non-objects out of the spread', () => {
    const { lines, restore } = capture();
    const log = createLogger('info', 'json');
    log.info('http', { level: 'nope', time: 'nope', msg: 'nope', status: 200 });
    log.info('boom', new Error('bang'), ['a', 'b']);
    restore();
    const [first, second] = lines
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(first.level).toBe('info');
    expect(first.time).not.toBe('nope');
    expect(first.msg).toBe('http');
    expect(first.status).toBe(200);
    // An Error spreads to nothing and an array spreads to 0/1/2, so neither is treated as
    // a field object: both stay in the message.
    expect(second.msg).toContain('bang');
    expect(second.msg).toContain('a');
    expect(second[0]).toBeUndefined();
  });
  it('respects the level threshold', () => {
    const { lines, restore } = capture();
    createLogger('warn', 'text').info('hidden');
    restore();
    expect(lines.join('')).toBe('');
  });
});

describe('ZOTEUS_LOG_FILE', () => {
  /** The stream writes asynchronously: wait for the file to hold what was logged. */
  async function fileContent(path: string, expected: string): Promise<string> {
    const { readFileSync } = await import('node:fs');
    for (let i = 0; i < 100; i++) {
      try {
        const text = readFileSync(path, 'utf8');
        if (text.includes(expected)) return text;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${path} never held "${expected}"`);
  }

  it('appends every line to the file as well as stderr, in the same format', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const path = join(mkdtempSync(join(tmpdir(), 'zoteus-log-')), 'zoteus.log');
    const { lines, restore } = capture();
    const log = createLogger('info', 'json', { file: path });
    log.info('first', { status: 200 });
    log.warn('second', { token: 'secret' });
    restore();
    const text = await fileContent(path, 'second');
    const records = text.trim().split('\n').map((l) => JSON.parse(l));
    expect(records.map((r) => r.msg)).toEqual(['first', 'second']);
    expect(records[0].status).toBe(200);
    // The file gets exactly what stderr got, redaction included.
    expect(text).not.toContain('secret');
    expect(lines.join('')).toBe(text);
  });

  it('reports a file it cannot write once, and keeps logging to stderr', async () => {
    const { lines, restore } = capture();
    const log = createLogger('info', 'text', { file: '/nonexistent-dir-zoteus/zoteus.log' });
    log.info('still here');
    await new Promise((r) => setTimeout(r, 50));
    log.info('and here');
    restore();
    const out = lines.join('');
    expect(out).toContain('not writable');
    expect(out).toContain('still here');
    expect(out).toContain('and here');
  });
});
