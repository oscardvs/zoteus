import CSL from 'citeproc';

export interface FormatOptions {
  items: any[];
  styleXml: string;
  localeXml: string;
  format?: 'html' | 'text' | 'rtf';
}

export interface FormatResult {
  bibliography: string;
  entries: string[];
}

/** Format a CSL-JSON item list into a bibliography using citeproc-js. */
export function formatBibliography(opts: FormatOptions): FormatResult {
  // Defensive: accept a bare array or a { items: [...] } wrapper (Zotero csljson shape).
  const items: any[] = Array.isArray(opts.items) ? opts.items : ((opts.items as any)?.items ?? []);
  const byId: Record<string, any> = {};
  items.forEach((it, i) => {
    const id = it.id ?? `ITEM-${i + 1}`;
    byId[id] = { ...it, id };
  });

  const sys = {
    retrieveLocale: (_lang: string) => opts.localeXml,
    retrieveItem: (id: string) => byId[id],
  };

  const engine = new CSL.Engine(sys, opts.styleXml);
  if (opts.format) engine.setOutputFormat(opts.format);
  engine.updateItems(Object.keys(byId));
  const result = engine.makeBibliography();
  const entries: string[] = result && Array.isArray(result[1]) ? result[1] : [];
  return { bibliography: entries.join('').trim(), entries };
}

/** One item inside a citation cluster: which work, and where in it. */
export interface ClusterItem {
  /** CSL id, matching the `id` of one of the items handed to renderCitations. */
  id: string;
  locator?: string;
  /** CSL locator term, e.g. "page" or "chapter". */
  label?: string;
  prefix?: string;
  suffix?: string;
  suppressAuthor?: boolean;
}

export interface Cluster {
  /** Stable id for this cluster; the same value goes into the field's `citationID`. */
  id: string;
  items: ClusterItem[];
}

export interface RenderCitationsOptions {
  items: any[];
  styleXml: string;
  localeXml: string;
  clusters: Cluster[];
  /** Render a bibliography of the cited items too (default true). */
  bibliography?: boolean;
  /** Output format for both the clusters and the bibliography (default "text"). */
  format?: 'html' | 'text' | 'rtf';
}

export interface RenderCitationsResult {
  /** One rendered string per cluster, in the order the clusters were given. */
  citations: string[];
  /** Bibliography entries, in the style's own order; empty when none was asked for. */
  entries: string[];
  /** Per-cluster problems citeproc reported, e.g. an id it could not retrieve. */
  errors: string[];
}

/**
 * Render citation clusters, and optionally the bibliography, on ONE citeproc engine.
 *
 * This is the call the repo did not have. `makeBibliography` alone cannot produce the text
 * a Word field caches, and rendering each cluster in isolation (previewCitationCluster)
 * gets two things wrong that readers notice: a numeric style would number every cluster
 * "1", and an author-date style could not disambiguate two 2026 papers by the same author
 * into "2026a" and "2026b".
 *
 * `processCitationCluster` is the call that gets both right, because it keeps the document
 * state. It also RETURNS revisions to clusters already emitted (registering the second
 * Devos 2026 paper changes the first citation from "2026" to "2026a"), which is why the
 * results are collected by position and overwritten as later clusters arrive, rather than
 * pushed once and left.
 */
export function renderCitations(opts: RenderCitationsOptions): RenderCitationsResult {
  const items: any[] = Array.isArray(opts.items) ? opts.items : ((opts.items as any)?.items ?? []);
  const byId: Record<string, any> = {};
  items.forEach((it, i) => {
    const id = it.id ?? `ITEM-${i + 1}`;
    byId[id] = { ...it, id };
  });

  const sys = {
    retrieveLocale: (_lang: string) => opts.localeXml,
    retrieveItem: (id: string) => byId[id],
  };

  const engine = new CSL.Engine(sys, opts.styleXml);
  engine.setOutputFormat(opts.format ?? 'text');

  const citations: string[] = new Array(opts.clusters.length).fill('');
  const errors: string[] = [];
  // citationsPre is [[citationID, noteIndex], ...] for everything already in the document.
  const pre: [string, number][] = [];

  for (const cluster of opts.clusters) {
    const citation = {
      citationID: cluster.id,
      citationItems: cluster.items.map((item) => {
        const out: Record<string, unknown> = { id: item.id };
        if (item.locator) out.locator = item.locator;
        if (item.label) out.label = item.label;
        if (item.prefix) out.prefix = item.prefix;
        if (item.suffix) out.suffix = item.suffix;
        if (item.suppressAuthor) out['suppress-author'] = true;
        return out;
      }),
      // 0 is "in text". A note style asked to render at noteIndex 0 renders the note
      // content inline, which is what this document does: it writes no footnotes.
      properties: { noteIndex: 0 },
    };
    const result = engine.processCitationCluster(citation, pre.slice(), []);
    const status = result?.[0] as { citation_errors?: string[] } | undefined;
    for (const message of status?.citation_errors ?? []) errors.push(String(message));
    for (const update of (result?.[1] ?? []) as [number, string, string][]) {
      const [position, text] = update;
      if (position >= 0 && position < citations.length) citations[position] = text;
    }
    pre.push([cluster.id, 0]);
  }

  let entries: string[] = [];
  if (opts.bibliography !== false) {
    const bib = engine.makeBibliography();
    entries = (bib && Array.isArray(bib[1]) ? bib[1] : []).map((entry: string) => entry.trim());
  }

  return { citations, entries, errors };
}
