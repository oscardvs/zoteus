import { describe, it, expect } from 'vitest';
import { citedKeys, markdownToNoteHtml, renderInline, safeUrl } from '../../src/features/notes/markdown.js';
import { appendToNote, wrapNote } from '../../src/features/notes/note-html.js';
import { citationHtml, citationPreview, cslItemData, itemUri } from '../../src/features/notes/citations.js';

/**
 * Markdown to the HTML Zotero's note editor stores. The shapes asserted here are the ones
 * Zotero 10.0.6's note editor reads and writes (its ProseMirror schema in
 * resource/note-editor/editor.js): `<pre>` for code, `<span class="math">` and
 * `<pre class="math">` for math, `<span style="text-decoration: line-through">` for strike.
 */
describe('markdownToNoteHtml: blocks', () => {
  it('renders headings, paragraphs and horizontal rules', () => {
    expect(markdownToNoteHtml('# One\n\n## Two\n\nText here.\n\n---\n\nMore.')).toBe(
      '<h1>One</h1>\n<h2>Two</h2>\n<p>Text here.</p>\n<hr>\n<p>More.</p>',
    );
  });

  it('renders setext headings the way CommonMark does', () => {
    expect(markdownToNoteHtml('Title\n=====\n\nSub\n---')).toBe('<h1>Title</h1>\n<h2>Sub</h2>');
  });

  it('renders tight and nested lists without paragraph wrappers', () => {
    expect(markdownToNoteHtml('- a\n- b\n  - nested *x*\n- c')).toBe(
      '<ul>\n<li>a</li>\n<li>b<ul>\n<li>nested <em>x</em></li>\n</ul></li>\n<li>c</li>\n</ul>',
    );
  });

  it('nests four-space indented lists too, as models usually write them', () => {
    expect(markdownToNoteHtml('1. first\n    - inner\n2. second')).toBe(
      '<ol>\n<li>first<ul>\n<li>inner</li>\n</ul></li>\n<li>second</li>\n</ol>',
    );
  });

  it('keeps an ordered list\'s start number', () => {
    expect(markdownToNoteHtml('3. three\n4. four')).toBe('<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>');
  });

  it('wraps a loose list item\'s paragraphs', () => {
    expect(markdownToNoteHtml('- one\n\n  two')).toBe('<ul>\n<li><p>one</p>\n<p>two</p></li>\n</ul>');
  });

  it('renders blockquotes, with Markdown inside', () => {
    expect(markdownToNoteHtml('> quoted **here**\n> and on\n\nafter')).toBe(
      '<blockquote>\n<p>quoted <strong>here</strong>\nand on</p>\n</blockquote>\n<p>after</p>',
    );
  });

  it('keeps fenced code verbatim and escaped', () => {
    expect(markdownToNoteHtml('```ts\nif (a < b && c) {}\n  [@ABCD2345]\n```')).toBe(
      '<pre>if (a &lt; b &amp;&amp; c) {}\n  [@ABCD2345]</pre>',
    );
  });

  it('renders pipe tables, padding short rows', () => {
    expect(markdownToNoteHtml('| a | b |\n|---|:-:|\n| 1 | `x|y` |\n| 2 |')).toBe(
      '<table>\n<tbody>\n<tr><th>a</th><th>b</th></tr>\n<tr><td>1</td><td><code>x|y</code></td></tr>\n<tr><td>2</td><td></td></tr>\n</tbody>\n</table>',
    );
  });

  it('renders display math as the editor\'s math block', () => {
    expect(markdownToNoteHtml('$$\n\\int_0^1 f(x)\\,dx\n$$')).toBe('<pre class="math">$$\\int_0^1 f(x)\\,dx$$</pre>');
    expect(markdownToNoteHtml('$$E = mc^2$$')).toBe('<pre class="math">$$E = mc^2$$</pre>');
  });

  it('turns task-list boxes into glyphs the editor can show', () => {
    expect(markdownToNoteHtml('- [ ] todo\n- [x] done')).toBe('<ul>\n<li>\u2610 todo</li>\n<li>\u2611 done</li>\n</ul>');
  });

  it('does not let "2019. was good" start an ordered list inside a paragraph', () => {
    expect(markdownToNoteHtml('the year\n2019. was good')).toBe('<p>the year\n2019. was good</p>');
  });
});

describe('markdownToNoteHtml: inline', () => {
  it('renders emphasis, code, strike and links', () => {
    expect(renderInline('**b** *i* `c` ~~s~~ [l](https://x.org/a_b_c) snake_case_name')).toBe(
      '<strong>b</strong> <em>i</em> <code>c</code> <span style="text-decoration: line-through">s</span> ' +
        '<a href="https://x.org/a_b_c" rel="noopener noreferrer nofollow">l</a> snake_case_name',
    );
  });

  it('pairs nested emphasis the way CommonMark does', () => {
    expect(renderInline('***both***')).toBe('<strong><em>both</em></strong>');
    expect(renderInline('*a **b** c*')).toBe('<em>a <strong>b</strong> c</em>');
    expect(renderInline('**a *b* c**')).toBe('<strong>a <em>b</em> c</strong>');
    expect(renderInline('**a *b***')).toBe('<strong>a <em>b</em></strong>');
    expect(renderInline('*unclosed and **also')).toBe('*unclosed and **also');
    expect(renderInline('a * b * c')).toBe('a * b * c');
  });

  it('escapes raw HTML instead of passing it through', () => {
    expect(renderInline('<script>alert(1)</script> & <b>x</b>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;x&lt;/b&gt;',
    );
  });

  it('drops a link whose scheme is not allowed, keeping its text', () => {
    expect(renderInline('[click](javascript:alert(1))')).toBe('click');
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('doi:10.1000/xyz')).toBe('https://doi.org/10.1000/xyz');
    expect(safeUrl('zotero://select/library/items/ABCD2345')).toBe('zotero://select/library/items/ABCD2345');
  });

  it('links bare URLs without swallowing the sentence\'s punctuation', () => {
    expect(renderInline('see https://example.com/path). Or www.x.org.')).toBe(
      'see <a href="https://example.com/path" rel="noopener noreferrer nofollow">https://example.com/path</a>). ' +
        'Or <a href="https://www.x.org" rel="noopener noreferrer nofollow">www.x.org</a>.',
    );
  });

  it('renders inline math by Pandoc\'s rule, so prices stay text', () => {
    expect(renderInline('Costs $5 and $10; area is $\\pi r^2$.')).toBe(
      'Costs $5 and $10; area is <span class="math">$\\pi r^2$</span>.',
    );
  });

  it('turns two trailing spaces or a backslash into a line break', () => {
    expect(renderInline('one  \ntwo\\\nthree\nfour')).toBe('one<br>two<br>three\nfour');
  });

  it('honours backslash escapes', () => {
    expect(renderInline('\\*not em\\* and \\[@ABCD2345]')).toBe('*not em* and [@ABCD2345]');
  });
});

describe('citations in Markdown', () => {
  const render = (md: string) =>
    markdownToNoteHtml(md, { citation: (refs) => `{${JSON.stringify(refs)}}` });

  it('parses keys, locators, labels, prefixes and suffixes', () => {
    expect(render('[@ABCD2345, p. 12]')).toBe('<p>{[{"key":"ABCD2345","locator":"12"}]}</p>');
    expect(render('[see @ABCD2345; @WXYZ6789, pp. 3-5, emphasis added]')).toBe(
      '<p>{[{"key":"ABCD2345","prefix":"see"},{"key":"WXYZ6789","locator":"3-5","suffix":"emphasis added"}]}</p>',
    );
    expect(render('[@ABCD2345, ch. 3]')).toBe('<p>{[{"key":"ABCD2345","locator":"3","label":"chapter"}]}</p>');
    expect(render('[@ABCD2345, 45]')).toBe('<p>{[{"key":"ABCD2345","locator":"45"}]}</p>');
  });

  it('leaves brackets that are not citations alone', () => {
    expect(render('[not a cite] and [@short] and [@ABCD23456]')).toBe('<p>[not a cite] and [@short] and [@ABCD23456]</p>');
  });

  it('lists cited keys outside code, once each, in order', () => {
    expect(citedKeys('a [@ABCD2345] `[@WXYZ6789]` [@QQQQ2222; @ABCD2345]\n\n```\n[@ZZZZ9999]\n```')).toEqual([
      'ABCD2345',
      'QQQQ2222',
    ]);
  });

  it('keeps [@KEY] as text when no renderer is given', () => {
    expect(markdownToNoteHtml('[@ABCD2345, p. 3]')).toBe('<p>[@ABCD2345, p. 3]</p>');
  });
});

describe('Zotero citation spans', () => {
  const smith = { author: [{ family: 'Smith', given: 'A' }], issued: { 'date-parts': [[2019]] }, title: 'T' };

  it('previews a cited item as the note editor does', () => {
    expect(citationPreview(smith)).toBe('Smith, 2019');
    expect(citationPreview({ ...smith, author: [{ family: 'Smith' }, { family: 'Jones' }] })).toBe('Smith and Jones, 2019');
    expect(citationPreview({ ...smith, author: [{ family: 'A' }, { family: 'B' }, { family: 'C' }] })).toBe('A et al., 2019');
    expect(citationPreview({ title: 'Untitled work' })).toBe('\u201cUntitled work\u201d');
    expect(citationPreview(smith, { locator: '12' })).toBe('Smith, 2019, p. 12');
    expect(citationPreview(smith, { locator: '12-14' })).toBe('Smith, 2019, pp. 12-14');
    expect(citationPreview(smith, { locator: '3', label: 'chapter', prefix: 'see' })).toBe('see Smith, 2019, chapter 3');
  });

  it('writes the span Zotero reads, with the item URI and locator', () => {
    const cited = new Map([['ABCD2345', { key: 'ABCD2345', uri: 'http://zotero.org/users/42/items/ABCD2345', itemData: smith }]]);
    const html = citationHtml([{ key: 'ABCD2345', locator: '4' }], cited);
    const data = /data-citation="([^"]+)"/.exec(html)![1]!;
    expect(JSON.parse(decodeURIComponent(data))).toEqual({
      citationItems: [{ uris: ['http://zotero.org/users/42/items/ABCD2345'], locator: '4' }],
      properties: {},
    });
    expect(html).toMatch(/>\(<span class="citation-item">Smith, 2019, p\. 4<\/span>\)<\/span>$/);
  });

  it('names items by the URIs Zotero resolves', () => {
    expect(itemUri({ type: 'group', id: 6666644 }, 'ABCD2345')).toBe('http://zotero.org/groups/6666644/items/ABCD2345');
    expect(itemUri({ type: 'user', id: 0 }, 'ABCD2345', 19552201)).toBe('http://zotero.org/users/19552201/items/ABCD2345');
    expect(itemUri({ type: 'user', id: 0 }, 'ABCD2345')).toBe('http://zotero.org/users/0/items/ABCD2345');
  });

  it('prefers Zotero\'s own CSL-JSON, in either API\'s shape, and builds one otherwise', () => {
    const own = { id: 'x', type: 'book', title: 'Own' };
    expect(cslItemData({ csljson: JSON.stringify([own]) }, 'u')).toEqual(own);
    expect(cslItemData({ csljson: { items: [own] } }, 'u')).toEqual(own);
    expect(
      cslItemData(
        { data: { itemType: 'journalArticle', title: 'T', date: 'March 2019', creators: [{ creatorType: 'author', lastName: 'Smith', firstName: 'A' }] } },
        'u',
      ),
    ).toMatchObject({ type: 'article-journal', title: 'T', author: [{ family: 'Smith', given: 'A' }], issued: { 'date-parts': [[2019]] } });
  });
});

describe('note wrapper', () => {
  const item = { uris: ['http://zotero.org/users/1/items/ABCD2345'], itemData: { title: 'T' } };

  it('wraps a body in the schema-9 container, with cited items when there are any', () => {
    expect(wrapNote('<p>x</p>')).toBe('<div data-schema-version="9"><p>x</p>\n</div>');
    const html = wrapNote('<p>x</p>', [item]);
    expect(html.startsWith('<div data-citation-items="')).toBe(true);
    expect(JSON.parse(decodeURIComponent(/data-citation-items="([^"]+)"/.exec(html)![1]!))).toEqual([item]);
  });

  it('appends inside the container, merging cited items and keeping other attributes', () => {
    const other = { uris: ['http://zotero.org/users/1/items/WXYZ6789'], itemData: { title: 'U' } };
    const existing = `<div data-citation-items="${encodeURIComponent(JSON.stringify([item]))}" data-schema-version="10" data-x="keep"><p>old</p>\n</div>`;
    const out = appendToNote(existing, '<p>new</p>', [item, other]);
    expect(out).toMatch(/data-schema-version="10"/);
    expect(out).toMatch(/data-x="keep"/);
    expect(out).toMatch(/<p>old<\/p>\n<p>new<\/p>\n<\/div>$/);
    expect(JSON.parse(decodeURIComponent(/data-citation-items="([^"]+)"/.exec(out)![1]!))).toEqual([item, other]);
  });

  it('leaves a pre-editor note as it was unless there is citation metadata to carry', () => {
    const legacy = '<div class="zotero-note znv1"><p>old</p></div>';
    expect(appendToNote(legacy, '<p>new</p>')).toBe(`${legacy}\n<p>new</p>`);
    expect(appendToNote(legacy, '<p>new</p>', [item])).toMatch(/^<div data-citation-items="[^"]+" data-schema-version="9"><div class="zotero-note znv1">/);
    expect(appendToNote('', '<p>new</p>')).toBe('<div data-schema-version="9"><p>new</p>\n</div>');
  });
});
