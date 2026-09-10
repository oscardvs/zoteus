import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, optionalLibrary } from '../registry/registry.js';
import { refuseUnknownCollection } from './collection-guard.js';
import type { LibraryRef } from '../api/web-client.js';
import {
  auditOffTaxonomy,
  auditMissingTiers,
  type Vocabulary,
  type TagInfo,
  type AuditItem,
} from '../features/tags/audit.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * `collectionKeys`, `Collection-Keys` and `collection_keys` all reduce to `collectionkeys`,
 * which is what lets a key whose only fault is its spelling be paired with the field it meant.
 */
const fold = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The words a field name is built from, singular, so that `collections` and `collection_keys`
 * are seen to share one. camelCase counts as a word boundary, like `_` and `-` do.
 */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 2 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/**
 * Whether `key` is a misspelling of `field` rather than a different idea altogether. Two
 * rules, both of them things callers really type: a name that truncates or extends the
 * field (`require` for `required`, `tier` for `tiers`), and a name built out of a subset of
 * the field's words (`collections` or `keys` for `collection_keys`). Plain folding alone
 * would catch neither, which is why the annotate fix's rule is not enough here: the near
 * miss that started this was `collections`, and no amount of case and separator folding
 * turns that into `collection_keys`.
 */
function isTwin(key: string, field: string): boolean {
  const a = fold(key);
  const b = fold(field);
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const kw = new Set(words(key));
  const fw = new Set(words(field));
  const [fewer, more] = kw.size <= fw.size ? [kw, fw] : [fw, kw];
  return fewer.size > 0 && [...fewer].every((w) => more.has(w));
}

/**
 * Names the key that was not understood and, where only its spelling was wrong, the one it
 * was probably meant to be. A key that resembles two fields at once resolves to neither:
 * guessing between them would be worse than listing what is on offer.
 */
function unknownKeyProblem(key: string, where: string, fields: string[]): string {
  const twins = fields.filter((f) => isTwin(key, f));
  const twin = twins.length === 1 ? twins[0] : undefined;
  const named = twin
    ? `unknown key \`${key}\` in ${where}: this tool spells it \`${twin}\`.`
    : `unknown key \`${key}\` in ${where}. The keys are: ${fields.join(', ')}.`;
  return `${named} Nothing was audited, because the value you sent would have been dropped and the audit would have answered a different question.`;
}

/**
 * A `z.object` that refuses a key it does not know, rather than dropping it.
 *
 * Every object in the vocabulary and in `scope` has optional members, and `z.object` strips
 * what it does not recognise before the handler ever sees it, so `scope: {"collections":
 * [...]}` reached the handler as `{}` and the audit ran over the whole library and reported
 * the run as a success. The same held for `tier` on a vocabulary tag (every item then counts
 * as missing that tier), for `required` on a tier and for `tiers` on the vocabulary itself
 * (no tier is required, so the audit reports no gaps at all). An argument that is silently
 * discarded is the one failure a caller cannot detect, so it fails here instead.
 *
 * `preprocess` rather than `.strict()` because the useful part of the message is the twin,
 * which Zod's own "Unrecognized key(s) in object" cannot offer; the object underneath stays
 * a plain one, so the JSON Schema this tool advertises still says additionalProperties:false
 * at every level, which it already did and had never enforced.
 */
function closedObject<T extends z.ZodRawShape>(shape: T, where: string) {
  const fields = Object.keys(shape);
  return z.preprocess((value, ctx) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    for (const key of Object.keys(value)) {
      if (key in shape) continue;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: unknownKeyProblem(key, where, fields) });
    }
    return value;
  }, z.object(shape));
}

const vocabTagSchema = closedObject({ name: z.string(), tier: z.string().optional() }, 'a `vocabulary.tags` entry');
const vocabTierSchema = closedObject(
  { name: z.string(), required: z.boolean().optional() },
  'a `vocabulary.tiers` entry',
);
const vocabSchema = closedObject(
  {
    tags: z.array(vocabTagSchema),
    tiers: z.array(vocabTierSchema).optional(),
  },
  '`vocabulary`',
);
const scopeSchema = closedObject({ collection_keys: z.array(z.string()).optional() }, '`scope`');

/** Zod's own `error.message` is a JSON dump of the issues; a caller reading a file wants the sentences. */
function explainIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('\n- ');
}

async function listAllTags(ctx: ToolContext, lib: LibraryRef): Promise<TagInfo[]> {
  const out: TagInfo[] = [];
  let start = 0;
  const limit = 100;
  for (;;) {
    const r = await ctx.router.listTags({ library: lib, limit, start });
    for (const t of r.data) {
      if (typeof t === 'string') out.push({ name: t, auto: false });
      else out.push({ name: t.tag, numItems: t.meta?.numItems, auto: t.meta?.type === 1 }); // Zotero: type 1 = automatic
    }
    start += r.data.length;
    if (!r.data.length || start >= r.totalResults) break;
  }
  return out;
}

async function listItems(
  ctx: ToolContext,
  library: LibraryRef | undefined,
  collectionKey?: string,
): Promise<AuditItem[]> {
  const out: AuditItem[] = [];
  let start = 0;
  const limit = 100;
  for (;;) {
    const r = await ctx.router.searchItems({ top: true, limit, start, collectionKey, library });
    for (const it of r.data) {
      const d = it.data ?? it;
      if (d.itemType === 'attachment' || d.itemType === 'note') continue;
      out.push({ key: it.key ?? d.key, title: d.title, tags: (d.tags ?? []).map((t: any) => t.tag) });
    }
    start += r.data.length;
    if (!r.data.length || start >= r.totalResults) break;
  }
  return out;
}

const tagAudit: ToolDefinition = {
  name: 'zotero_tag_audit',
  title: 'Audit tags against a controlled vocabulary',
  description:
    'Audit a library against a controlled tag vocabulary with priority tiers. Provide the vocabulary inline as `vocabulary` (or a JSON file via `vocabulary_path`): { tags:[{name,tier?}], tiers?:[{name,required?}] }. Reports (1) off-taxonomy tags (library tags not in the vocabulary; Zotero auto-applied tags are bucketed separately unless include_auto), (2) items missing a tag from each required tier, and (3) optional per-collection coverage when `scope.collection_keys` is given. A key that none of these objects knows is refused and named, never dropped: a dropped `scope`, `tier` or `required` would change the question without changing the answer. Read-only. Tag and item enumeration both follow the library route, so a running Zotero desktop app serves the whole audit with no cloud API key.',
  inputSchema: {
    vocabulary: vocabSchema.optional(),
    vocabulary_path: z.string().optional().describe('Path to a JSON file with the vocabulary.'),
    scope: scopeSchema
      .optional()
      .describe(
        'Per-collection coverage: `{ collection_keys: [...] }`. A key this tool does not know is refused, never ignored.',
      ),
    include_auto: z.boolean().optional().describe('Treat Zotero auto-applied tags as off-taxonomy too.'),
    limit: z.number().int().min(1).max(500).optional().describe('Max items listed per report (default 50).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    let vocab: Vocabulary;
    if (args.vocabulary && args.vocabulary_path) return err('Provide only one of `vocabulary` or `vocabulary_path`.');
    if (args.vocabulary) vocab = args.vocabulary;
    else if (args.vocabulary_path) {
      let vocabPath: string;
      try {
        vocabPath = await resolveCallerPath(args.vocabulary_path, {
          dataDir: ctx.config.dataDir,
          confined: ctx.remoteCaller,
          mode: 'read',
          argName: 'vocabulary_path',
          alternative: 'Pass the vocabulary inline with `vocabulary` instead.',
        });
      } catch (e) {
        if (e instanceof CallerPathError) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
        throw e;
      }
      const raw = await readFile(vocabPath, 'utf8').catch(() => null);
      if (raw == null) return err(`Could not read vocabulary file: ${args.vocabulary_path}`);
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return err(`Vocabulary file is not valid JSON: ${args.vocabulary_path}`);
      }
      const parsed = vocabSchema.safeParse(json);
      if (!parsed.success) {
        return err(`Vocabulary file is invalid: ${args.vocabulary_path}\n- ${explainIssues(parsed.error)}`);
      }
      vocab = parsed.data;
    } else return err('Provide a `vocabulary` object or a `vocabulary_path`.');

    const library: LibraryRef | undefined = optionalLibrary(args);
    const lib = library ?? ctx.router.defaultLibrary();
    const cap = args.limit ?? 50;

    // A scope key this library does not have would otherwise be audited as though it did:
    // the desktop app answers `/collections/<unknown>/items` with the WHOLE library, so
    // that collection's coverage came back counting every item in the library (measured:
    // 285 against the 6 the real collection holds), labelled as that collection and with
    // nothing in the answer to say which question had been answered. In an audit that is
    // the worst possible wrong answer, because a mistyped key reports compliance nobody
    // has. Refused before any listing work, exactly as zotero_search_items and
    // zotero_export already refuse the same key.
    for (const ck of args.scope?.collection_keys ?? []) {
      const unknown = await refuseUnknownCollection(ctx, ck, lib, 'audited');
      if (unknown) return unknown;
    }

    const libraryTags = await listAllTags(ctx, lib);
    const { offTaxonomy, autoTags } = auditOffTaxonomy(libraryTags, vocab, Boolean(args.include_auto));

    const items = await listItems(ctx, library);
    const missingByTier = auditMissingTiers(items, vocab).map((m) => ({
      tier: m.tier,
      itemCount: m.itemCount,
      items: m.items.slice(0, cap),
      omitted: Math.max(0, m.itemCount - cap),
    }));

    const collections: Array<{ collectionKey: string; missingByTier: typeof missingByTier }> = [];
    for (const ck of args.scope?.collection_keys ?? []) {
      const colItems = await listItems(ctx, library, ck);
      collections.push({
        collectionKey: ck,
        missingByTier: auditMissingTiers(colItems, vocab).map((m) => ({
          tier: m.tier,
          itemCount: m.itemCount,
          items: m.items.slice(0, cap),
          omitted: Math.max(0, m.itemCount - cap),
        })),
      });
    }

    const summary =
      `Audited ${libraryTags.length} tag(s) over ${items.length} item(s): ` +
      `${offTaxonomy.length} off-taxonomy, ${autoTags.length} auto, ` +
      `${missingByTier.reduce((n, m) => n + m.itemCount, 0)} required-tier gap(s).`;
    return ok(
      {
        offTaxonomy: offTaxonomy.slice(0, cap),
        offTaxonomyTotal: offTaxonomy.length,
        autoTags: autoTags.slice(0, cap),
        autoTagsTotal: autoTags.length,
        missingByTier,
        collections: collections.length ? collections : undefined,
        itemsScanned: items.length,
      },
      summary,
    );
  },
};

export default tagAudit;
