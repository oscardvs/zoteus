import type { ZoteroSchema } from '../../schema/schema-service.js';
import {
  SNAPSHOT_DATE_FIELDS,
  SNAPSHOT_NAMES,
  SNAPSHOT_TEXT_FIELDS,
  SNAPSHOT_TYPES,
} from './csl-tables.js';
import type { BibRecord } from './record.js';

/**
 * Turning a CSL-shaped record into Zotero item-data, using Zotero's own tables.
 *
 * Zotero publishes the mapping in its global schema and this server already fetches and
 * caches it (SchemaService). Three tables do the work:
 *
 *   - `csl.types`: CSL type -> the Zotero item types that express it;
 *   - `csl.fields`: CSL variable -> the Zotero fields (or BASE fields) that hold it;
 *   - `csl.names`: Zotero creator type -> CSL name variable, which inverts to what we need.
 *
 * The fourth input is `itemTypes`, the per-type field list, and it is what makes the
 * difference between a usable import and a pile of Extra lines. `csl.fields.text` says a
 * container title lives in `publicationTitle`, but a conferencePaper has no field by that
 * name: it has `proceedingsTitle`, declared with `baseField: "publicationTitle"`. So each
 * item type gets an index of `field -> field` AND `baseField -> field`, and a CSL variable
 * is resolved against that index. The same step puts a thesis's publisher in `university`
 * and its genre in `thesisType`, with nothing type-specific written here.
 *
 * A variable that lands nowhere is not dropped. It goes into Extra as `name: value`, which
 * is where Zotero itself parks what its schema cannot model, so no data from the file is
 * lost even when its shape has no home.
 */

/** What an item type accepts: where each field name lands, and which creators are legal. */
interface ItemTypeShape {
  /** Field name or base-field name -> the concrete field to write. */
  fields: Map<string, string>;
  creatorTypes: Set<string>;
  /** The type's primary creator, used when a record's creator role is not legal here. */
  primaryCreator: string;
}

export interface MappingTables {
  /** Whether the live schema or the offline snapshot supplied the tables. */
  origin: 'schema' | 'snapshot';
  types: Record<string, string[]>;
  textFields: Record<string, string[]>;
  dateFields: Record<string, string>;
  /** CSL name variable -> Zotero creator type (the inverse of the schema's `csl.names`). */
  creatorTypes: Record<string, string>;
  /** Absent when the tables came from the snapshot, which carries no item-type field lists. */
  itemTypes?: Map<string, ItemTypeShape>;
}

/** Item types that are not bibliographic records and must never be created by an import. */
const NOT_A_RECORD = new Set(['attachment', 'note', 'annotation']);

/**
 * A lookup by a key that came out of a file, answering only with what the table itself holds.
 *
 * `tables.types`, `tables.textFields` and `tables.creatorTypes` are plain objects: the
 * snapshot ones are object literals and the live ones come from `JSON.parse`, so both
 * inherit from `Object.prototype`. Indexing them with a name out of a payload therefore
 * answers with an inherited member for a handful of keys, and `?? fallback` never fires
 * because a function is not nullish. A CSL-JSON item with `"type": "constructor"` turned
 * `tables.types[cslType]` into a function and `(...).filter` threw, out of a function whose
 * contract is that it never throws, which failed the whole import rather than one entry.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function invert(names: Record<string, string>): Record<string, string> {
  // Null-prototype: with a plain object, `out['constructor'] ??= zotero` would never assign,
  // because the inherited constructor is not nullish.
  const out: Record<string, string> = Object.create(null);
  for (const [zotero, csl] of Object.entries(names)) {
    // Several Zotero creator types share one CSL name ("creator" and "author" both map to
    // "author"); the first one wins, which is the order the schema lists them in.
    out[csl] ??= zotero;
  }
  return out;
}

/** The tables, from the live Zotero schema when one was fetched and the snapshot otherwise. */
export function mappingTables(schema?: ZoteroSchema): MappingTables {
  const csl = schema?.csl as
    | { types?: Record<string, string[]>; fields?: { text?: Record<string, string[]>; date?: Record<string, string> }; names?: Record<string, string> }
    | undefined;
  if (!schema || !csl?.types || !csl.fields?.text) {
    return {
      origin: 'snapshot',
      types: SNAPSHOT_TYPES,
      textFields: SNAPSHOT_TEXT_FIELDS,
      dateFields: SNAPSHOT_DATE_FIELDS,
      creatorTypes: invert(SNAPSHOT_NAMES),
    };
  }
  const itemTypes = new Map<string, ItemTypeShape>();
  for (const def of schema.itemTypes ?? []) {
    const fields = new Map<string, string>();
    for (const f of def.fields ?? []) {
      fields.set(f.field, f.field);
      if (f.baseField) fields.set(f.baseField, f.field);
    }
    const creators = def.creatorTypes ?? [];
    itemTypes.set(def.itemType, {
      fields,
      creatorTypes: new Set(creators.map((c) => c.creatorType)),
      primaryCreator: creators.find((c) => c.primary)?.creatorType ?? creators[0]?.creatorType ?? 'author',
    });
  }
  return {
    origin: 'schema',
    types: csl.types,
    textFields: csl.fields.text,
    dateFields: csl.fields.date ?? SNAPSHOT_DATE_FIELDS,
    creatorTypes: invert(csl.names ?? SNAPSHOT_NAMES),
    itemTypes,
  };
}

/** Zotero item-data, as the write paths take it. */
export type ZoteroItemData = Record<string, unknown>;

export interface MappedItem {
  item: ZoteroItemData;
  warnings: string[];
}

/** The Zotero item type for a CSL type, and whether the table actually knew it. */
function itemTypeFor(cslType: string, tables: MappingTables): { itemType: string; known: boolean } {
  const listed = own(tables.types, cslType);
  const candidates = (Array.isArray(listed) ? listed : []).filter((t) => typeof t === 'string' && !NOT_A_RECORD.has(t));
  if (!candidates.length) return { itemType: 'document', known: false };
  if (!tables.itemTypes) return { itemType: candidates[0]!, known: true };
  const usable = candidates.find((t) => tables.itemTypes!.has(t));
  return usable ? { itemType: usable, known: true } : { itemType: 'document', known: false };
}

/** Where a CSL variable lands on this item type, or undefined when it lands nowhere. */
function fieldFor(variable: string, itemType: string, tables: MappingTables): string | undefined {
  const dated = own(tables.dateFields, variable);
  const listed = own(tables.textFields, variable);
  const candidates =
    typeof dated === 'string' && dated ? [dated] : Array.isArray(listed) ? listed.filter((c) => typeof c === 'string') : [];
  const shape = tables.itemTypes?.get(itemType);
  if (!shape) return candidates[0];
  for (const candidate of candidates) {
    const landed = shape.fields.get(candidate);
    if (landed) return landed;
  }
  return undefined;
}

/** One record into Zotero item-data. Never throws: everything it cannot place is reported. */
export function toZoteroItem(record: BibRecord, tables: MappingTables): MappedItem {
  const warnings: string[] = [];
  const { itemType, known } = itemTypeFor(record.cslType, tables);
  if (!known && record.cslType !== 'document') {
    warnings.push(
      `${record.label}: Zotero has no item type for CSL type "${record.cslType}", so it was imported as a generic document.`,
    );
  }

  const item: ZoteroItemData = { itemType };
  const extra: string[] = [...record.extra];

  for (const [variable, value] of Object.entries(record.fields)) {
    if (!value) continue;
    const field = fieldFor(variable, itemType, tables);
    if (!field) {
      extra.push(`${variable}: ${value}`);
      continue;
    }
    if (field === 'extra') {
      extra.push(value);
      continue;
    }
    // A CSL variable that resolves onto a field another variable already claimed keeps the
    // first one and parks the second, rather than overwriting what was there.
    if (item[field] !== undefined) {
      extra.push(`${variable}: ${value}`);
      continue;
    }
    item[field] = value;
  }

  const shape = tables.itemTypes?.get(itemType);
  let demoted = false;
  const creators = record.creators
    .filter((c) => c.family || c.given || c.literal)
    .map((c) => {
      const named = typeof c.cslName === 'string' ? own(tables.creatorTypes, c.cslName) : undefined;
      let creatorType = typeof named === 'string' && named ? named : 'author';
      if (shape && !shape.creatorTypes.has(creatorType)) {
        demoted = demoted || creatorType !== shape.primaryCreator;
        creatorType = shape.primaryCreator;
      }
      return c.literal !== undefined
        ? { creatorType, name: c.literal }
        : { creatorType, firstName: c.given ?? '', lastName: c.family ?? '' };
    });
  if (creators.length) item.creators = creators;
  if (demoted) {
    warnings.push(
      `${record.label}: a creator role in this entry is not one Zotero allows on "${itemType}", ` +
        `so those creators were recorded as "${shape?.primaryCreator ?? 'author'}".`,
    );
  }

  const tags = [...new Set(record.tags.map((t) => t.trim()).filter(Boolean))];
  if (tags.length) item.tags = tags.map((tag) => ({ tag }));

  if (extra.length) {
    const existing = typeof item.extra === 'string' && item.extra ? [item.extra] : [];
    item.extra = [...existing, ...extra].join('\n');
  }

  if (!item.title) {
    warnings.push(`${record.label}: no title could be read from this entry.`);
  }
  return { item, warnings };
}

/** Every record into Zotero item-data, with the warnings collected in record order. */
export function toZoteroItems(
  records: BibRecord[],
  tables: MappingTables,
): { items: ZoteroItemData[]; warnings: string[] } {
  const items: ZoteroItemData[] = [];
  const warnings: string[] = [];
  for (const record of records) {
    const mapped = toZoteroItem(record, tables);
    items.push(mapped.item);
    warnings.push(...mapped.warnings);
  }
  return { items, warnings };
}
