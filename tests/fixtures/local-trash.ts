/**
 * A real slice of a Zotero 10 desktop library's trash, captured from its local API
 * (http://127.0.0.1:23119/api/users/0) during the 2026-10-01 stress test, and a stand-in
 * for that local API that answers filtered listings the way the real one does.
 *
 * Real rather than invented because what is under test is the desktop's shape of a trashed
 * item, and it is not the obvious one: a child of a trashed parent is in the trash without
 * carrying `deleted` itself (CNFVGR6X, BAEJPE8T below), and an annotation can be trashed on
 * its own while its attachment is not (PLDMINXM). Only `library` and `links` were trimmed.
 *
 * What the real desktop answered that day, for the record (Total-Results of each request):
 *
 *   /items?tag=zoteus-stress-test&includeTrashed=1        0   (55 items carry the tag, all trashed)
 *   /items/trash?tag=zoteus-stress-test                   0
 *   /items?q=ZST&includeTrashed=1                         55
 *   /items/trash?q=ZST                                    55
 *   /items/trash?itemType=journalArticle                  0   (several trashed journalArticles)
 *   /items/top?itemKey=JMT2P9IT,ZINCUGAP&includeTrashed=1 1   (JMT2P9IT is trashed)
 *   /items/JMT2P9IT                                       200, data.deleted: true
 *
 * and the cloud Web API, asked the same of the same synced library, answered 55, 55, 55,
 * 55, and 2 for the keyed read.
 */

export const LIBRARY_VERSION = 1869;

/** Items in no trash at all. */
export const LIVE: Record<string, any> = {
  ZINCUGAP: {
    key: 'ZINCUGAP',
    version: 1669,
    meta: { creatorSummary: 'Zhu et al.', parsedDate: '2026-08-24', numChildren: 1 },
    data: {
      key: 'ZINCUGAP',
      version: 1669,
      itemType: 'preprint',
      title: 'Learning to Act While Waiting: RL Finetuning of Generalist Robot Policies Under Inference Latency',
      tags: [{ tag: 'VLA' }, { tag: 'RL' }],
      collections: ['9Z8Z7SVT', 'CE2IUBZS'],
      dateAdded: '2026-09-22T05:09:39Z',
      dateModified: '2026-09-22T05:09:52Z',
    },
  },
  KMBR5HXX: {
    key: 'KMBR5HXX',
    version: 1422,
    meta: { creatorSummary: 'Pertsch et al.', parsedDate: '2025-01-16', numChildren: 1 },
    data: {
      key: 'KMBR5HXX',
      version: 1422,
      itemType: 'preprint',
      title: 'FAST: Efficient Action Tokenization for Vision-Language-Action Models',
      tags: [{ tag: 'VLA' }, { tag: 'method · autoregressive' }],
      collections: ['CE2IUBZS'],
      dateAdded: '2026-08-26T06:29:28Z',
      dateModified: '2026-09-16T16:17:47Z',
    },
  },
  '2I2V3PHQ': {
    key: '2I2V3PHQ',
    version: 315,
    meta: { numChildren: 0 },
    data: {
      key: '2I2V3PHQ',
      version: 315,
      itemType: 'attachment',
      title: 'Full Text PDF',
      parentItem: '8H9PBTTB',
      contentType: 'application/pdf',
      linkMode: 'imported_url',
      tags: [],
      dateModified: '2026-08-28T14:36:36Z',
    },
  },
};

/** Everything the desktop's /items/trash lists. */
export const TRASHED: Record<string, any> = {
  JMT2P9IT: {
    key: 'JMT2P9IT',
    version: 1866,
    meta: { numChildren: 0 },
    data: {
      key: 'JMT2P9IT',
      version: 1866,
      itemType: 'document',
      title: 'ZST item 55',
      tags: [{ tag: 'zoteus-stress-test' }],
      collections: [],
      deleted: true,
      dateAdded: '2026-10-01T05:45:08Z',
      dateModified: '2026-10-01T05:48:13Z',
    },
  },
  SCE6JNKP: {
    key: 'SCE6JNKP',
    version: 1813,
    meta: { numChildren: 0 },
    data: {
      key: 'SCE6JNKP',
      version: 1813,
      itemType: 'document',
      title: 'ZST item 03',
      tags: [{ tag: 'zoteus-stress-test' }, { tag: 'zst-日本語' }, { tag: 'zst/α-β' }],
      collections: [],
      deleted: true,
      dateAdded: '2026-10-01T05:45:07Z',
      dateModified: '2026-10-01T05:46:26Z',
    },
  },
  H2ACW4ET: {
    key: 'H2ACW4ET',
    version: 1811,
    meta: { parsedDate: '2026-10-01', numChildren: 0 },
    data: {
      key: 'H2ACW4ET',
      version: 1811,
      itemType: 'document',
      title: 'ZST item 01 (edited)',
      tags: [{ tag: 'zoteus-stress-test' }, { tag: 'zst-日本語' }, { tag: 'zst/α-β' }],
      collections: [],
      deleted: true,
      dateAdded: '2026-10-01T05:45:06Z',
      dateModified: '2026-10-01T05:46:25Z',
    },
  },
  CG4253NT: {
    key: 'CG4253NT',
    version: 701,
    meta: { creatorSummary: 'Probe', parsedDate: '2026-09-10', numChildren: 0 },
    data: {
      key: 'CG4253NT',
      version: 701,
      itemType: 'preprint',
      title: 'ZOTEUS 1.18.0 VERIFY personal-scratch',
      tags: [{ tag: 'zoteus-118-verify' }, { tag: 'zoteus-118-second' }, { tag: 'zoteus-118-tagtest' }],
      deleted: true,
      dateModified: '2026-09-10T12:44:32Z',
    },
  },
  PLDMINXM: {
    key: 'PLDMINXM',
    version: 700,
    data: {
      key: 'PLDMINXM',
      version: 700,
      itemType: 'annotation',
      parentItem: '2I2V3PHQ',
      annotationType: 'highlight',
      annotationText: 'Policy gradient methods are an appealing approach in reinforcement learning',
      tags: [{ tag: 'zoteus-118-verify' }],
      deleted: true,
      dateModified: '2026-09-10T12:44:03Z',
    },
  },
  FSQF48MS: {
    key: 'FSQF48MS',
    version: 681,
    meta: { numChildren: 1 },
    data: {
      key: 'FSQF48MS',
      version: 681,
      itemType: 'journalArticle',
      title: 'Zoteus 1.18.0 annotation defect probe (agent, delete me)',
      tags: [],
      deleted: true,
      dateModified: '2026-09-10T08:58:05Z',
    },
  },
  // In the trash because its parent is, with no `deleted` of its own.
  CNFVGR6X: {
    key: 'CNFVGR6X',
    version: 674,
    meta: { numChildren: 0 },
    data: {
      key: 'CNFVGR6X',
      version: 674,
      itemType: 'attachment',
      title: 'probe.pdf',
      parentItem: 'FSQF48MS',
      tags: [],
      dateModified: '2026-09-10T08:48:17Z',
    },
  },
  BAEJPE8T: {
    key: 'BAEJPE8T',
    version: 678,
    meta: { numChildren: 0 },
    data: {
      key: 'BAEJPE8T',
      version: 678,
      itemType: 'annotation',
      parentItem: 'CNFVGR6X',
      annotationType: 'highlight',
      tags: [],
      dateModified: '2026-09-10T08:57:49Z',
    },
  },
};

export const ALL: Record<string, any> = { ...LIVE, ...TRASHED };

/** One `tag`/`itemType` parameter, read the way the desktop's buildSearchFromSearchSyntax reads it. */
function clauseMatches(raw: string, has: (v: string) => boolean, isAnnotation: boolean): boolean {
  let s = raw;
  let negate = false;
  if (s[0] === '-') {
    negate = true;
    s = s.slice(1);
  }
  if (s[0] === '\\' && s[1] === '-') s = s.slice(1);
  const ors = s.split('||').map((v) => v.trim());
  // Zotero never lets a negated item-level condition match an annotation.
  if (negate) return !isAnnotation && ors.some((v) => !has(v));
  return ors.some(has);
}

function sortKeys(keys: string[], sort: string | null, direction: string | null): string[] {
  const field = sort ?? 'dateModified';
  const dir = direction === 'asc' ? 1 : direction === 'desc' ? -1 : field.startsWith('date') ? -1 : 1;
  const value = (k: string) => String(ALL[k].data[field] ?? '');
  return keys.slice().sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0));
}

/**
 * A stand-in for the desktop local API over the slice above, answering a filtered listing
 * the way Zotero 10 does: `tag`, `itemType` and `itemKey` are each evaluated in a search of
 * their own that never sees the trash, so they match no trashed item whatever path or
 * `includeTrashed` the request carried. Everything else (`q`, `top`, the /trash path,
 * `includeTrashed`, sort and paging) is answered correctly, and a direct read by key
 * answers a trashed item too. Every request URL is recorded in `calls`.
 */
export function fakeTrashDesktop() {
  const calls: string[] = [];
  const fetchImpl = async (rawUrl: string): Promise<Response> => {
    calls.push(rawUrl);
    const url = new URL(rawUrl);
    const sp = url.searchParams;
    const path = url.pathname.replace(/^\/api\/users\/0/, '');
    const single = /^\/items\/([A-Z0-9]{8})$/.exec(path);
    if (single) {
      const item = ALL[single[1]!];
      return item
        ? new Response(JSON.stringify(item), { status: 200 })
        : new Response('Not found', { status: 404 });
    }
    const m = /^\/items(\/trash)?(\/top)?$/.exec(path);
    if (!m) return new Response('No endpoint found', { status: 404 });
    const [, trashPath, topPath] = m;

    let keys = Object.keys(ALL).filter((k) =>
      trashPath ? k in TRASHED : sp.get('includeTrashed') === '1' ? true : k in LIVE,
    );
    if (topPath) keys = keys.filter((k) => !ALL[k].data.parentItem);
    const q = sp.get('q');
    if (q) keys = keys.filter((k) => String(ALL[k].data.title ?? '').toLowerCase().includes(q.toLowerCase()));

    // The defect: each of these is a sub-search that excludes the trash.
    const filtered = sp.getAll('tag').length || sp.getAll('itemType').length || sp.has('itemKey');
    if (filtered) keys = keys.filter((k) => k in LIVE);
    for (const raw of sp.getAll('tag')) {
      keys = keys.filter((k) => {
        const d = ALL[k].data;
        const tags = new Set((d.tags ?? []).map((t: any) => t.tag));
        return clauseMatches(raw, (v) => tags.has(v), d.itemType === 'annotation');
      });
    }
    for (const raw of sp.getAll('itemType')) {
      keys = keys.filter((k) => {
        const d = ALL[k].data;
        return clauseMatches(raw, (v) => d.itemType === v, d.itemType === 'annotation');
      });
    }
    const itemKey = sp.get('itemKey');
    if (itemKey) {
      // Off /top, a keyed read also answers with every descendant of the items named.
      const named = new Set(itemKey.split(','));
      const descends = (k: string): boolean => {
        const parent = ALL[k]?.data.parentItem;
        return Boolean(parent) && (named.has(parent) || descends(parent));
      };
      keys = keys.filter((k) => named.has(k) || (!topPath && descends(k)));
    }

    keys = sortKeys(keys, sp.get('sort'), sp.get('direction'));
    const total = keys.length;
    const start = Number(sp.get('start') ?? 0);
    const limit = sp.has('limit') ? Number(sp.get('limit')) : total - start;
    keys = keys.slice(start, start + limit);
    const headers = { 'Total-Results': String(total), 'Last-Modified-Version': String(LIBRARY_VERSION) };
    if (sp.get('format') === 'keys') return new Response(keys.join('\n'), { status: 200, headers });
    return new Response(JSON.stringify(keys.map((k) => ALL[k])), { status: 200, headers });
  };
  return { fetchImpl, calls };
}
