/**
 * What a merge would do, computed from the records as they are now.
 *
 * Kept separate from the tool that performs it, and kept pure, because the plan is the
 * safety mechanism: it is what the caller reads before anything is written, and it is what
 * the writing path then executes step for step. If the two were computed differently, the
 * preview would be describing a different merge from the one that runs.
 *
 * The rule the whole module is built around: a merge only ever FILLS a field the master is
 * missing. It never replaces a value the master already has. Trashing a duplicate is
 * reversible (it lands in the Zotero trash); overwriting the master's abstract is not.
 */

/** An item as both APIs hand it over. */
export interface ItemRecord {
  key: string;
  version?: number;
  data: Record<string, unknown>;
}

/** A child note or attachment, and which duplicate it currently hangs off. */
export interface ChildRecord {
  key: string;
  version?: number;
  itemType?: string;
  title?: string;
  from: string;
}

export interface PlannedField {
  before: unknown;
  after: unknown;
  /** Key of the duplicate the value would come from. */
  from: string;
}

export interface SkippedField {
  field: string;
  from: string;
  reason: string;
}

export interface MergePlan {
  masterTitle?: string;
  fields: Record<string, PlannedField>;
  fieldsSkipped: SkippedField[];
  tagsAdded: string[];
  collectionsAdded: string[];
  relationsAdded: Record<string, string[]>;
  childrenToMove: Array<{ key: string; itemType?: string; title?: string; from: string }>;
  duplicatesToTrash: string[];
}

/**
 * Keys that are never copied field-for-field: the item's identity and bookkeeping, the
 * structural arrays this module unions separately, and the attachment-only keys that
 * describe a file rather than a work.
 */
const NOT_A_FILLABLE_FIELD = new Set([
  'key',
  'version',
  'itemType',
  'tags',
  'collections',
  'relations',
  'dateAdded',
  'dateModified',
  'parentItem',
  'deleted',
  'inPublications',
  'md5',
  'mtime',
  'linkMode',
  'filename',
  'contentType',
  'charset',
  'note',
]);

/** The Zotero predicate a merge records on the surviving item, pointing at what it absorbed. */
export const REPLACES_PREDICATE = 'dc:replaces';

/** Empty enough to fill: absent, null, the empty string, or an empty array. */
export function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function tagName(t: unknown): string | undefined {
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object' && typeof (t as any).tag === 'string') return (t as any).tag;
  return undefined;
}

/** Relations as a predicate to list-of-URIs map, whichever of the two shapes Zotero sent. */
export function normaliseRelations(value: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [pred, v] of Object.entries(value as Record<string, unknown>)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && x !== '');
    if (list.length) out[pred] = [...new Set(list)];
  }
  return out;
}

/** Back to the shape Zotero writes: one URI as a string, several as an array. */
export function denormaliseRelations(rel: Record<string, string[]>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [pred, list] of Object.entries(rel)) {
    if (!list.length) continue;
    out[pred] = list.length === 1 ? list[0]! : list;
  }
  return out;
}

export interface MergePlanOptions {
  master: ItemRecord;
  duplicates: ItemRecord[];
  children: ChildRecord[];
  /** Renders the Zotero URI of an item key in this library, for the relations. */
  itemUri: (key: string) => string;
  /**
   * Whether a field exists on the master's item type. Absent when the Zotero schema could
   * not be read, in which case nothing is filtered and Zotero itself refuses the write.
   */
  fieldAllowed?: (field: string) => boolean;
  /** Same, for creator types, since those are validated per item type too. */
  creatorTypeAllowed?: (creatorType: string) => boolean;
  /**
   * Duplicates the caller has already ruled out of the trash, e.g. because their children
   * could not be listed. The plan is the caller's safety artefact, so it must not announce a
   * trashing the same response reports as refused.
   */
  unsafeToTrash?: ReadonlySet<string>;
}

/**
 * The plan, and the single PATCH that carries it.
 *
 * The patch always contains `relations`, because a merge records what it absorbed even when
 * it fills nothing: after the duplicates are in the trash, that relation is the only trace
 * left of where the master's collections and tags came from.
 */
export function buildMergePlan(opts: MergePlanOptions): {
  plan: MergePlan;
  patch: Record<string, unknown>;
} {
  const { master, duplicates, children, itemUri, unsafeToTrash } = opts;
  const masterData = master.data ?? {};

  const fields: Record<string, PlannedField> = {};
  const fieldsSkipped: SkippedField[] = [];

  for (const dup of duplicates) {
    for (const [field, value] of Object.entries(dup.data ?? {})) {
      if (field === 'creators') continue; // handled below, against the creator-type rules
      if (NOT_A_FILLABLE_FIELD.has(field)) continue;
      if (isEmptyValue(value)) continue;
      if (!isEmptyValue(masterData[field])) continue; // never overwrite
      if (fields[field]) continue; // first duplicate to supply it wins
      if (opts.fieldAllowed && !opts.fieldAllowed(field)) {
        fieldsSkipped.push({
          field,
          from: dup.key,
          reason: `"${field}" is not a field of itemType "${String(masterData.itemType ?? 'unknown')}", so Zotero would refuse it.`,
        });
        continue;
      }
      fields[field] = { before: masterData[field], after: value, from: dup.key };
    }
  }

  // Creators, only when the master has none at all. Replacing an author list is exactly the
  // kind of loss this tool must not cause, so a master that already has creators keeps them.
  if (isEmptyValue(masterData.creators)) {
    for (const dup of duplicates) {
      const creators = dup.data?.creators;
      if (!Array.isArray(creators) || !creators.length) continue;
      if (fields.creators) break;
      const bad = opts.creatorTypeAllowed
        ? creators
            .map((c) => (c && typeof c === 'object' ? String((c as any).creatorType ?? '') : ''))
            .filter((t) => t && !opts.creatorTypeAllowed!(t))
        : [];
      if (bad.length) {
        fieldsSkipped.push({
          field: 'creators',
          from: dup.key,
          reason: `creator type "${bad[0]}" is not valid for itemType "${String(masterData.itemType ?? 'unknown')}", so Zotero would refuse the whole write.`,
        });
        continue;
      }
      fields.creators = { before: masterData.creators, after: creators, from: dup.key };
    }
  }

  // Tags: unioned by name. PATCH replaces an array wholesale, so the patch carries the
  // master's own tags as well as the additions, never the additions alone.
  const masterTags = Array.isArray(masterData.tags) ? masterData.tags : [];
  const haveTags = new Set(masterTags.map(tagName).filter(Boolean) as string[]);
  const addedTagObjects: unknown[] = [];
  const tagsAdded: string[] = [];
  for (const dup of duplicates) {
    const dupTags = Array.isArray(dup.data?.tags) ? (dup.data.tags as unknown[]) : [];
    for (const t of dupTags) {
      const name = tagName(t);
      if (!name || haveTags.has(name)) continue;
      haveTags.add(name);
      tagsAdded.push(name);
      addedTagObjects.push(typeof t === 'string' ? { tag: t } : t);
    }
  }

  const masterCollections = (Array.isArray(masterData.collections) ? masterData.collections : []).filter(
    (c): c is string => typeof c === 'string',
  );
  const haveCollections = new Set(masterCollections);
  const collectionsAdded: string[] = [];
  for (const dup of duplicates) {
    const dupCols = Array.isArray(dup.data?.collections) ? (dup.data.collections as unknown[]) : [];
    for (const c of dupCols) {
      if (typeof c !== 'string' || haveCollections.has(c)) continue;
      haveCollections.add(c);
      collectionsAdded.push(c);
    }
  }

  // Relations: the duplicates' own relations move to the master (Zotero's own merge does the
  // same), plus the dc:replaces link that records the merge itself.
  const merged = normaliseRelations(masterData.relations);
  const relationsAdded: Record<string, string[]> = {};
  const masterUri = itemUri(master.key);
  const addRelation = (pred: string, uri: string): void => {
    if (uri === masterUri) return; // an item never replaces itself
    const list = (merged[pred] ??= []);
    if (list.includes(uri)) return;
    list.push(uri);
    (relationsAdded[pred] ??= []).push(uri);
  };
  for (const dup of duplicates) {
    for (const [pred, uris] of Object.entries(normaliseRelations(dup.data?.relations))) {
      for (const uri of uris) addRelation(pred, uri);
    }
  }
  for (const dup of duplicates) addRelation(REPLACES_PREDICATE, itemUri(dup.key));

  const patch: Record<string, unknown> = {};
  for (const [field, planned] of Object.entries(fields)) patch[field] = planned.after;
  if (tagsAdded.length) patch.tags = [...masterTags, ...addedTagObjects];
  if (collectionsAdded.length) patch.collections = [...masterCollections, ...collectionsAdded];
  patch.relations = denormaliseRelations(merged);

  return {
    plan: {
      masterTitle: typeof masterData.title === 'string' ? masterData.title : undefined,
      fields,
      fieldsSkipped,
      tagsAdded,
      collectionsAdded,
      relationsAdded,
      childrenToMove: children.map(({ key, itemType, title, from }) => ({ key, itemType, title, from })),
      // The plan is the caller's safety artefact, so it must not announce a trashing the same
      // response reports as refused: a duplicate the caller has already ruled out (its
      // children could not be listed, say) is left off this list rather than promised.
      duplicatesToTrash: duplicates.map((d) => d.key).filter((k) => !unsafeToTrash?.has(k)),
    },
    patch,
  };
}
