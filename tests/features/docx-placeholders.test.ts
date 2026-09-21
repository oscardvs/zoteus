import { describe, it, expect } from 'vitest';
import { collectItemKeys, parseLocator, parseParagraph } from '../../src/features/docx/placeholders.js';

describe('[[cite:...]] parsing', () => {
  it('splits a paragraph into text and citations, in order', () => {
    expect(parseParagraph('Before [[cite:ABCD1234]] after.')).toEqual([
      { type: 'text', text: 'Before ' },
      { type: 'cite', cite: { raw: '[[cite:ABCD1234]]', items: [{ itemKey: 'ABCD1234' }] } },
      { type: 'text', text: ' after.' },
    ]);
  });

  it('reads a locator after the comma', () => {
    const [segment] = parseParagraph('[[cite:ABCD1234,p. 12]]');
    expect(segment).toEqual({
      type: 'cite',
      cite: { raw: '[[cite:ABCD1234,p. 12]]', items: [{ itemKey: 'ABCD1234', locator: '12', label: 'page' }] },
    });
  });

  it('puts several works in ONE cluster when they are separated by a semicolon', () => {
    const [segment] = parseParagraph('[[cite:ABCD1234;EFGH5678,ch. 3]]');
    expect(segment).toMatchObject({
      type: 'cite',
      cite: {
        items: [{ itemKey: 'ABCD1234' }, { itemKey: 'EFGH5678', locator: '3', label: 'chapter' }],
      },
    });
  });

  it('upper-cases an item key that has the shape of one, and leaves anything else alone', () => {
    expect(parseParagraph('[[cite:abcd1234]]')).toMatchObject([
      { cite: { items: [{ itemKey: 'ABCD1234' }] } },
    ]);
    // Not eight characters, so not a key shape: left exactly as typed, to fail visibly.
    expect(parseParagraph('[[cite:some-citation-key]]')).toMatchObject([
      { cite: { items: [{ itemKey: 'some-citation-key' }] } },
    ]);
  });

  it('leaves a malformed placeholder in the text rather than swallowing it', () => {
    expect(parseParagraph('a [[cite:]] b')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: '[[cite:]]' },
      { type: 'text', text: ' b' },
    ]);
  });

  it('handles several placeholders in one paragraph', () => {
    const segments = parseParagraph('[[cite:AAAAAAAA]] and [[cite:BBBBBBBB]]');
    expect(segments.map((s) => s.type)).toEqual(['cite', 'text', 'cite']);
  });

  it('collects distinct keys in first-appearance order', () => {
    expect(
      collectItemKeys(['[[cite:BBBBBBBB]] x [[cite:AAAAAAAA]]', 'y [[cite:BBBBBBBB,12]]']),
    ).toEqual(['BBBBBBBB', 'AAAAAAAA']);
  });
});

describe('locator labels', () => {
  it('maps the abbreviations people type', () => {
    expect(parseLocator('p. 12')).toEqual({ locator: '12', label: 'page' });
    expect(parseLocator('pp. 12-14')).toEqual({ locator: '12-14', label: 'page' });
    expect(parseLocator('chap. 3')).toEqual({ locator: '3', label: 'chapter' });
    expect(parseLocator('sec 2.1')).toEqual({ locator: '2.1', label: 'section' });
    expect(parseLocator('vol. 4')).toEqual({ locator: '4', label: 'volume' });
    expect(parseLocator('§5')).toEqual({ locator: '5', label: 'section' });
    expect(parseLocator('¶ 7')).toEqual({ locator: '7', label: 'paragraph' });
  });

  it('treats a bare number as a page, which is what Zotero does', () => {
    expect(parseLocator('12')).toEqual({ locator: '12', label: 'page' });
    expect(parseLocator(' 12-14 ')).toEqual({ locator: '12-14', label: 'page' });
  });

  it('keeps an unrecognised prefix in the locator rather than inventing a label', () => {
    // "slide 4" is not a CSL locator term; dropping "slide" would change what the citation
    // says, so the whole string stays and the label falls back to page.
    expect(parseLocator('slide 4')).toEqual({ locator: 'slide 4', label: 'page' });
  });

  it('returns nothing for an empty locator', () => {
    expect(parseLocator('   ')).toBeUndefined();
  });
});
