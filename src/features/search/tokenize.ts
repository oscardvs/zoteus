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
  'µ': 'μ', // U+00B5 MICRO SIGN: unicode61 unifies it with Greek mu, so µm answers to μm.
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
  // Lowercase every cased letter EXCEPT those unicode61's case table does not reach —
  // per character rather than String.prototype.toLowerCase over the whole string, so the
  // exceptions need no placeholder round-trip. The one divergence from whole-string
  // lowercasing is context-sensitive Greek final sigma, and UNIFY folds ς and σ together
  // anyway, so both routes land on the same token.
  const lowered = text.replace(/[\p{Lu}\p{Lt}]/gu, (c) => (UNICODE61_KEEPS_CASE.has(c) ? c : c.toLowerCase()));
  const folded = NO_TRANSFORM_SHIELD.hide(lowered)
    // Lowercasing can itself introduce a mark (`İ` → `i` + U+0307), so decompose after it.
    .normalize('NFD')
    .replace(LATIN_MARKS, '$1')
    // Recompose what was kept: the token class below excludes marks, exactly as unicode61
    // treats them as separators, so a decomposed `ά` left standing would split in two.
    .normalize('NFC')
    .replace(UNIFY_RE, (c) => UNIFY[c]!);
  return NO_TRANSFORM_SHIELD.show(folded);
}

/**
 * Characters shielded through the whole fold, because some step below would transform
 * them where unicode61 does not.
 *
 * `ǡ ǣ ǯ ǽ ǿ`: their base is itself a non-ASCII Latin letter, so unicode61's folding
 * table does not reach their mark — NFD plus the mark-stripping rule above would produce
 * `a æ ʒ æ ø`, real tokens other documents contain: the original defect in miniature,
 * confidently wrong rather than empty. Found by the codepoint sweep, which is also the
 * regression guard.
 *
 * `ʹ` U+0374 GREEK NUMERAL SIGN: left alone by SQLite while NFD decomposes it to U+02B9
 * MODIFIER LETTER PRIME — two codepoints that print alike and never match.
 */
const NO_TRANSFORM = '\u01e1\u01e3\u01ef\u01fd\u01ff\u0374';

/**
 * Every cased codepoint unicode61 leaves uppercase while `toLowerCase` would lower it.
 *
 * unicode61's case table predates Unicode 8, so whole scripts that gained casing later —
 * Cherokee, Georgian Mtavruli, Osage, Old Hungarian, Warang Citi, Deseret, Adlam,
 * Medefaidrin, Vithkuqi and friends — are stored uppercase by the index while a JS fold
 * would send the query lowercase, to a token the index does not hold. Not hand-listed:
 * GENERATED by sweeping every `\p{Lu}\p{Lt}` codepoint against a real FTS5 table
 * declared with the shipped tokenizer — insert `a${c}b`, MATCH the lowercase, keep `c`
 * when only the original matches. An earlier hand-listed pair turned out to be 2 of 445.
 */
const UNICODE61_KEEPS_CASE_CHARS = '\u037f\u0528\u052a\u052c\u052e\u13a0\u13a1\u13a2\u13a3\u13a4\u13a5\u13a6\u13a7\u13a8\u13a9\u13aa\u13ab\u13ac\u13ad\u13ae\u13af\u13b0\u13b1\u13b2\u13b3\u13b4\u13b5\u13b6\u13b7\u13b8\u13b9\u13ba\u13bb\u13bc\u13bd\u13be\u13bf\u13c0\u13c1\u13c2\u13c3\u13c4\u13c5\u13c6\u13c7\u13c8\u13c9\u13ca\u13cb\u13cc\u13cd\u13ce\u13cf\u13d0\u13d1\u13d2\u13d3\u13d4\u13d5\u13d6\u13d7\u13d8\u13d9\u13da\u13db\u13dc\u13dd\u13de\u13df\u13e0\u13e1\u13e2\u13e3\u13e4\u13e5\u13e6\u13e7\u13e8\u13e9\u13ea\u13eb\u13ec\u13ed\u13ee\u13ef\u13f0\u13f1\u13f2\u13f3\u13f4\u13f5\u1c89\u1c90\u1c91\u1c92\u1c93\u1c94\u1c95\u1c96\u1c97\u1c98\u1c99\u1c9a\u1c9b\u1c9c\u1c9d\u1c9e\u1c9f\u1ca0\u1ca1\u1ca2\u1ca3\u1ca4\u1ca5\u1ca6\u1ca7\u1ca8\u1ca9\u1caa\u1cab\u1cac\u1cad\u1cae\u1caf\u1cb0\u1cb1\u1cb2\u1cb3\u1cb4\u1cb5\u1cb6\u1cb7\u1cb8\u1cb9\u1cba\u1cbd\u1cbe\u1cbf\u2c2f\ua698\ua69a\ua796\ua798\ua79a\ua79c\ua79e\ua7ab\ua7ac\ua7ad\ua7ae\ua7b0\ua7b1\ua7b2\ua7b3\ua7b4\ua7b6\ua7b8\ua7ba\ua7bc\ua7be\ua7c0\ua7c2\ua7c4\ua7c5\ua7c6\ua7c7\ua7c9\ua7cb\ua7cc\ua7ce\ua7d0\ua7d2\ua7d4\ua7d6\ua7d8\ua7da\ua7dc\ua7f5\u{104B0}\u{104B1}\u{104B2}\u{104B3}\u{104B4}\u{104B5}\u{104B6}\u{104B7}\u{104B8}\u{104B9}\u{104BA}\u{104BB}\u{104BC}\u{104BD}\u{104BE}\u{104BF}\u{104C0}\u{104C1}\u{104C2}\u{104C3}\u{104C4}\u{104C5}\u{104C6}\u{104C7}\u{104C8}\u{104C9}\u{104CA}\u{104CB}\u{104CC}\u{104CD}\u{104CE}\u{104CF}\u{104D0}\u{104D1}\u{104D2}\u{104D3}\u{10570}\u{10571}\u{10572}\u{10573}\u{10574}\u{10575}\u{10576}\u{10577}\u{10578}\u{10579}\u{1057A}\u{1057C}\u{1057D}\u{1057E}\u{1057F}\u{10580}\u{10581}\u{10582}\u{10583}\u{10584}\u{10585}\u{10586}\u{10587}\u{10588}\u{10589}\u{1058A}\u{1058C}\u{1058D}\u{1058E}\u{1058F}\u{10590}\u{10591}\u{10592}\u{10594}\u{10595}\u{10C80}\u{10C81}\u{10C82}\u{10C83}\u{10C84}\u{10C85}\u{10C86}\u{10C87}\u{10C88}\u{10C89}\u{10C8A}\u{10C8B}\u{10C8C}\u{10C8D}\u{10C8E}\u{10C8F}\u{10C90}\u{10C91}\u{10C92}\u{10C93}\u{10C94}\u{10C95}\u{10C96}\u{10C97}\u{10C98}\u{10C99}\u{10C9A}\u{10C9B}\u{10C9C}\u{10C9D}\u{10C9E}\u{10C9F}\u{10CA0}\u{10CA1}\u{10CA2}\u{10CA3}\u{10CA4}\u{10CA5}\u{10CA6}\u{10CA7}\u{10CA8}\u{10CA9}\u{10CAA}\u{10CAB}\u{10CAC}\u{10CAD}\u{10CAE}\u{10CAF}\u{10CB0}\u{10CB1}\u{10CB2}\u{10D50}\u{10D51}\u{10D52}\u{10D53}\u{10D54}\u{10D55}\u{10D56}\u{10D57}\u{10D58}\u{10D59}\u{10D5A}\u{10D5B}\u{10D5C}\u{10D5D}\u{10D5E}\u{10D5F}\u{10D60}\u{10D61}\u{10D62}\u{10D63}\u{10D64}\u{10D65}\u{118A0}\u{118A1}\u{118A2}\u{118A3}\u{118A4}\u{118A5}\u{118A6}\u{118A7}\u{118A8}\u{118A9}\u{118AA}\u{118AB}\u{118AC}\u{118AD}\u{118AE}\u{118AF}\u{118B0}\u{118B1}\u{118B2}\u{118B3}\u{118B4}\u{118B5}\u{118B6}\u{118B7}\u{118B8}\u{118B9}\u{118BA}\u{118BB}\u{118BC}\u{118BD}\u{118BE}\u{118BF}\u{16E40}\u{16E41}\u{16E42}\u{16E43}\u{16E44}\u{16E45}\u{16E46}\u{16E47}\u{16E48}\u{16E49}\u{16E4A}\u{16E4B}\u{16E4C}\u{16E4D}\u{16E4E}\u{16E4F}\u{16E50}\u{16E51}\u{16E52}\u{16E53}\u{16E54}\u{16E55}\u{16E56}\u{16E57}\u{16E58}\u{16E59}\u{16E5A}\u{16E5B}\u{16E5C}\u{16E5D}\u{16E5E}\u{16E5F}\u{16EA0}\u{16EA1}\u{16EA2}\u{16EA3}\u{16EA4}\u{16EA5}\u{16EA6}\u{16EA7}\u{16EA8}\u{16EA9}\u{16EAA}\u{16EAB}\u{16EAC}\u{16EAD}\u{16EAE}\u{16EAF}\u{16EB0}\u{16EB1}\u{16EB2}\u{16EB3}\u{16EB4}\u{16EB5}\u{16EB6}\u{16EB7}\u{16EB8}\u{1E900}\u{1E901}\u{1E902}\u{1E903}\u{1E904}\u{1E905}\u{1E906}\u{1E907}\u{1E908}\u{1E909}\u{1E90A}\u{1E90B}\u{1E90C}\u{1E90D}\u{1E90E}\u{1E90F}\u{1E910}\u{1E911}\u{1E912}\u{1E913}\u{1E914}\u{1E915}\u{1E916}\u{1E917}\u{1E918}\u{1E919}\u{1E91A}\u{1E91B}\u{1E91C}\u{1E91D}\u{1E91E}\u{1E91F}\u{1E920}\u{1E921}';
export const UNICODE61_KEEPS_CASE: ReadonlySet<string> = new Set(UNICODE61_KEEPS_CASE_CHARS);

/**
 * A set of characters hidden behind noncharacters for the duration of the fold, and put
 * back afterwards.
 *
 * `U+FDD0..U+FDEF` are permanently reserved as noncharacters, so they cannot occur in the
 * text being folded — which is exactly what a placeholder needs and what a Private Use
 * Area codepoint could not promise. Sixteen slots against six members, and the
 * length assertion below keeps that honest if the set grows.
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

const NO_TRANSFORM_SHIELD = shield(NO_TRANSFORM, 0xfdd0);

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
