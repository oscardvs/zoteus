/**
 * The screening tag scheme: how a review team's decisions live in Zotero itself.
 *
 * A decision is an ordinary Zotero tag, so it syncs to every member of a group library,
 * shows in Zotero's tag selector, and outlives Zoteus. The shape is fixed:
 *
 *   screen/<stage>/<decision>[:<reason>][@<reviewer>]
 *
 *   - stage: `title-abstract` or `full-text`
 *   - decision: `include`, `exclude` or `maybe`
 *   - reason: only on `exclude`, a lowercase slug such as `wrong-population`
 *   - reviewer: a lowercase slug such as `alice`; absent on the FINAL (consensus) decision
 *
 * Examples: `screen/title-abstract/include`, `screen/title-abstract/exclude:wrong-population`,
 * `screen/full-text/include@alice`, `screen/full-text/exclude:no-outcome-data@bob`.
 *
 * An item holds at most one tag per (stage, reviewer) pair, and at most one final tag per
 * stage. Anything that starts with `screen/` but does not parse is left alone and reported,
 * never rewritten, because it may be the team's own convention.
 */

export const SCREEN_PREFIX = 'screen/';
export const STAGES = ['title-abstract', 'full-text'] as const;
export const DECISIONS = ['include', 'exclude', 'maybe'] as const;
export type Stage = (typeof STAGES)[number];
export type Decision = (typeof DECISIONS)[number];

export interface ScreeningTag {
  stage: Stage;
  decision: Decision;
  reason?: string;
  /** Absent on the final (consensus or single-reviewer) decision. */
  reviewer?: string;
}

const TAG_RE = /^screen\/(title-abstract|full-text)\/(include|exclude|maybe)(?::([a-z0-9][a-z0-9-]*))?(?:@([a-z0-9][a-z0-9._-]*))?$/;

/** A slug for a reason or reviewer: lowercase, runs of anything else become one hyphen. */
export function slug(value: string, keepDots = false): string {
  const allowed = keepDots ? /[^a-z0-9._-]+/g : /[^a-z0-9-]+/g;
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(allowed, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export function parseScreeningTag(tag: string): ScreeningTag | undefined {
  const m = TAG_RE.exec(tag);
  if (!m) return undefined;
  const out: ScreeningTag = { stage: m[1] as Stage, decision: m[2] as Decision };
  if (m[3]) {
    // A reason only means something on an exclusion; on anything else the tag is malformed.
    if (out.decision !== 'exclude') return undefined;
    out.reason = m[3];
  }
  if (m[4]) out.reviewer = m[4];
  return out;
}

export function formatScreeningTag(t: ScreeningTag): string {
  return (
    `${SCREEN_PREFIX}${t.stage}/${t.decision}` +
    (t.decision === 'exclude' && t.reason ? `:${t.reason}` : '') +
    (t.reviewer ? `@${t.reviewer}` : '')
  );
}

/** True for a tag in the screening namespace that the scheme cannot read. */
export function isMalformedScreeningTag(tag: string): boolean {
  return tag.startsWith(SCREEN_PREFIX) && !parseScreeningTag(tag);
}

/**
 * The tag list after recording `next`: every tag kept except the screening tag for the same
 * stage and the same reviewer (or the same final slot), which `next` replaces. User tags,
 * other stages, other reviewers and malformed `screen/` tags are never touched.
 */
export function replaceScreeningTag<T extends { tag: string }>(
  current: T[],
  next: ScreeningTag,
): { tags: Array<T | { tag: string }>; replaced: string[]; unchanged: boolean } {
  const wanted = formatScreeningTag(next);
  const replaced: string[] = [];
  const kept: Array<T | { tag: string }> = [];
  let had = false;
  for (const t of current) {
    const parsed = parseScreeningTag(t.tag);
    if (parsed && parsed.stage === next.stage && (parsed.reviewer ?? '') === (next.reviewer ?? '')) {
      if (t.tag === wanted && !had) {
        had = true;
        kept.push(t);
      } else {
        replaced.push(t.tag);
      }
      continue;
    }
    kept.push(t);
  }
  if (!had) kept.push({ tag: wanted });
  return { tags: kept, replaced, unchanged: had && replaced.length === 0 };
}
