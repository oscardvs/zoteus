const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'by', 'as', 'at', 'that', 'this', 'it', 'from', 'we', 'our', 'their', 'its', 'these', 'those',
]);

/**
 * Combining marks sitting on a **Latin** base, which is the only place
 * `unicode61 remove_diacritics 2` removes them: measured, Greek tonos and Cyrillic breve
 * survive there, so they survive here. See normalizeForSearch.
 *
 * U+0300–U+036F rather than `\p{M}`, which is the block NFD produces for Latin (Vietnamese
 * included: the tone marks and the dot below are all in it) and the range Zotero's own
 * normalizer strips. Not a shortcut — measured at 4,8 µs against 31,1 µs per 740-character
 * passage for the property class, and the codepoint-by-codepoint sweep described below
 * returns the same 22 divergences either way.
 */
const LATIN_MARKS = /(\p{Script=Latin})[\u0300-\u036f]+/gu;

/**
 * Letters unicode61 unifies that `String.prototype.toLowerCase` leaves alone. Measured
 * against the tokenizer, not guessed: `λόγος` indexes as `λόγοσ`, and `ſ` as `s`. `ẛ`
 * needs no entry of its own — NFD splits it into `ſ` plus a mark.
 */
const UNIFY: Record<string, string> = {
  'ſ': 's',
  'ς': 'σ',
  'ϐ': 'β', 'ϑ': 'θ', 'ϕ': 'φ', 'ϖ': 'π', 'ϰ': 'κ', 'ϱ': 'ρ', 'ϵ': 'ε',
};
const UNIFY_RE = new RegExp(`[${Object.keys(UNIFY).join('')}]`, 'gu');

/**
 * Fold a string to the form both sides of the index are compared in: lowercase, Latin
 * diacritics removed, everything else left standing.
 *
 * **Why this exists.** `tokenize()` used to match `[a-z0-9]+` over lowercased text, which
 * is adequate for English and a correctness defect for everything else. On the FTS5
 * backend the document side is folded by SQLite (`remove_diacritics 2`) while the query
 * side was not, so `théorie` reached MATCH as `"th" OR "orie"`. Because terms are OR-ed
 * that is not a miss but a confident wrong answer: `"th"` and `"orie"` retrieve whatever
 * ordinary prose happens to contain them. Measured on a 7 500-item library, an accented
 * query and its unaccented spelling shared not one result — jaccard 0,00.
 * The repair is Zotero's: fold in JS, in front of the tokeniser that the index side and
 * the query side already share, so the symmetry is structural rather than coincidental.
 *
 * **Why it emulates unicode61 rather than copying Zotero's `normalizeForSearch`.** Zotero
 * folds harder — NFKD, plus a hand map for `ø œ æ ł đ ð þ ß ı` — because it owns both
 * sides of its own comparison. We do not: `passages.text` is the display text `get()`
 * reads back for snippets, so the FTS5 document side stays raw and is tokenised by SQLite.
 * Anything this function does that `unicode61 remove_diacritics 2` does not re-opens the
 * asymmetry it exists to close. Measured, `đại` indexes as `đai` and `søren` as `søren`;
 * folding either here would send the query where the index is not. So the hand map is
 * deliberately absent, and NFD is used rather than NFKD (`ﬁle` and `ａｂｃ` are indexed
 * whole, so they stay whole here).
 *
 * Swept codepoint by codepoint over Latin, Greek, Cyrillic, Latin Extended Additional,
 * letterlike and number forms, fullwidth and the ligatures — 1 301 codepoints. What it found
 * is pinned in `accent-folding.test.ts`, under "codepoints unicode61 does not fold the way
 * JavaScript would". An earlier reading of that sweep called all its residual divergences
 * harmless. **That was wrong**, and re-running it is what showed otherwise: twelve of them
 * sent the query to a token the index does not hold, which is this defect's own class on
 * rarer input. Ten were `Ǡ Ǣ Ǯ Ǽ Ǿ` with their lowercase forms and two were gaps in
 * unicode61's Greek case table; all twelve are handled by NO_MARK_STRIP and
 * NO_CASE_FOLD below. What remains is fifteen unassigned or symbol codepoints that
 * unicode61 indexes and `\p{L}\p{N}` does not — those genuinely do only retrieve less.
 */
export function normalizeForSearch(text: string): string {
  const lowered = CASE_SHIELD.hide(text).toLowerCase();
  const folded = MARK_SHIELD.hide(lowered)
    // Lowercasing can itself introduce a mark (`İ` → `i` + U+0307), so decompose after it.
    .normalize('NFD')
    .replace(LATIN_MARKS, '$1')
    // Recompose what was kept: the token class below excludes marks, exactly as unicode61
    // treats them as separators, so a decomposed `ά` left standing would split in two.
    .normalize('NFC')
    .replace(UNIFY_RE, (c) => UNIFY[c]!);
  return CASE_SHIELD.show(MARK_SHIELD.show(folded));
}

/**
 * Characters unicode61 lowercases but does NOT strip marks from, because its folding table
 * does not reach them: their base is itself a non-ASCII Latin letter.
 *
 * `ǡ ǣ ǯ ǽ ǿ` (and their capitals, which unicode61 does lowercase). NFD decomposes them
 * and the mark-stripping rule above then produces `a æ ʒ æ ø` — where the index holds
 * `ǡ ǣ ǯ ǽ ǿ`. That is not a narrowing; it is that same defect in miniature, on ten rare
 * codepoints: the query lands on a real token that other documents genuinely contain, so
 * it retrieves confidently and wrongly rather than retrieving nothing. Found by the
 * codepoint sweep, which is also the regression guard.
 */
const NO_MARK_STRIP = '\u01e1\u01e3\u01ef\u01fd\u01ff';

/**
 * Characters unicode61 does not transform at all, where JavaScript would.
 *
 * `U+037F` GREEK CAPITAL LETTER YOT is absent from unicode61's case table (it was added to
 * Unicode after it), so the index stores it uppercase while `toLowerCase` gives `ϳ`.
 * `U+0374` GREEK NUMERAL SIGN is left alone by SQLite while `normalize` maps it to `U+02B9`
 * MODIFIER LETTER PRIME — two codepoints that print alike and do not match.
 */
const NO_CASE_FOLD = '\u0374\u037f';

/**
 * A set of characters hidden behind noncharacters for the duration of the fold, and put
 * back afterwards.
 *
 * `U+FDD0..U+FDEF` are permanently reserved as noncharacters, so they cannot occur in the
 * text being folded — which is exactly what a placeholder needs and what a Private Use
 * Area codepoint could not promise. Each shield gets its own sixteen-slot block, because
 * the two are nested: the case shield is still in force while the mark shield is applied,
 * so sharing a block would hand the outer restore the inner's character. That is not
 * hypothetical; it is what the first version did, and `Ǽ Ϳ` came back as `ǽ ǽ`.
 *
 * The membership is fixed at module load, so a character always gets the same placeholder
 * and there is no allocation to run out of — the sets are two and five members against
 * sixteen slots, and the assertion below is what keeps that true if one grows.
 */
function shield(chars: string, base: number): { hide: (s: string) => string; show: (s: string) => string } {
  if (chars.length > 16) throw new Error(`shield: ${chars.length} characters do not fit one noncharacter block`);
  const slots = new Map([...chars].map((c, i) => [c, String.fromCharCode(base + i)]));
  const back = new Map([...slots].map(([c, slot]) => [slot, c]));
  // Both sets hold letters and marks only, so they need no escaping inside a class.
  const hideRe = new RegExp(`[${chars}]`, 'gu');
  const showRe = new RegExp(`[${[...back.keys()].join('')}]`, 'gu');
  return {
    hide: (s) => s.replace(hideRe, (c) => slots.get(c)!),
    show: (s) => s.replace(showRe, (c) => back.get(c)!),
  };
}

const CASE_SHIELD = shield(NO_CASE_FOLD, 0xfdd0);
const MARK_SHIELD = shield(NO_MARK_STRIP, 0xfde0);

/**
 * Fold, split on non-alphanumerics, drop stopwords and 1-char tokens.
 *
 * The token class is `\p{L}\p{N}`, not `[a-z0-9]`, and that half earns its place on its
 * own: it keeps `théorie`, `Θεωρία`, `теория` and `日本語` single tokens instead of
 * fragments, and it would have prevented this defect even without the fold — a whole token
 * misses cleanly, a fragment matches a high-frequency English string.
 */
export function tokenize(text: string): string[] {
  return (normalizeForSearch(text).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}
