import type { ExtractedField, FieldValue } from './record.js';

/** One field as the caller supplied it: a value, or null to remove the field. */
export interface FieldInput {
  name: string;
  value: FieldValue | null;
  quote?: string;
  page?: string;
}

export interface FieldChange {
  name: string;
  /** The value the note held before, when the field existed. */
  previous?: FieldValue;
  /** The value now stored; absent when the field was removed. */
  value?: FieldValue;
}

export interface MergeResult {
  fields: ExtractedField[];
  added: string[];
  replaced: FieldChange[];
  removed: FieldChange[];
  /** Fields the note held that this save left untouched. */
  kept: string[];
}

/**
 * The fields a save leaves in the note. Supplied fields replace a field of the same name in
 * place (keeping the column order a reader already knows) or are appended; a null value
 * removes the field; fields not mentioned are kept, unless `replaceAll` drops them too.
 */
export function mergeFields(existing: ExtractedField[], incoming: ExtractedField[], removals: string[], replaceAll: boolean): MergeResult {
  const out: ExtractedField[] = [];
  const added: string[] = [];
  const replaced: FieldChange[] = [];
  const removed: FieldChange[] = [];
  const kept: string[] = [];
  const byName = new Map(incoming.map((f) => [f.name, f]));
  const drop = new Set(removals);
  const seen = new Set<string>();
  for (const old of existing) {
    if (seen.has(old.name)) continue;
    seen.add(old.name);
    const next = byName.get(old.name);
    if (next) {
      out.push(next);
      replaced.push({ name: old.name, previous: old.value, value: next.value });
    } else if (drop.has(old.name) || replaceAll) {
      removed.push({ name: old.name, previous: old.value });
    } else {
      out.push(old);
      kept.push(old.name);
    }
  }
  for (const f of incoming) {
    if (seen.has(f.name)) continue;
    out.push(f);
    added.push(f.name);
  }
  return { fields: out, added, replaced, removed, kept };
}
