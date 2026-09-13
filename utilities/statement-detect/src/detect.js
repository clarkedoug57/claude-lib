/**
 * detect.js — which layout is this document?
 *
 * class: utility. Zero dependencies. Knows nothing about any parser or app:
 * a fingerprint is a set of patterns over the EXTRACTED TEXT, registered by
 * whoever owns the parser it routes to, and the answer is an id or a reason.
 *
 * THE RULE
 *   0 chars of text (below `minChars`)  → 'no-text'   the file is an image; no
 *                                                       fingerprint can run
 *   exactly one fingerprint matches      → 'match'     route to that id
 *   none match                           → 'unknown'   route to the layout agent
 *   two or more match                    → 'ambiguous' an error, never a guess:
 *                                                       two registrations
 *                                                       overlap and the registry
 *                                                       must be fixed
 *
 * A fingerprint matches when EVERY `must` pattern matches the text and NO
 * `mustNot` pattern does. Patterns are RegExps or literal strings (a string is
 * a case-insensitive substring). `version` is informational — it names the
 * layout revision the fingerprint was written against so a redesign that
 * breaks the parser can be registered as a new, distinguishable fingerprint
 * (mustNot the new form on the old, mustNot the old on the new).
 *
 * The registry is an explicit value, never module state: an app builds one,
 * registers what it can parse, and passes it in. Two apps, two registries.
 */

export const DETECT_OUTCOME = Object.freeze({
  MATCH: 'match',
  UNKNOWN: 'unknown',
  AMBIGUOUS: 'ambiguous',
  NO_TEXT: 'no-text',
});

/** Below this many non-whitespace characters, a text layer is treated as absent. */
export const DEFAULT_MIN_CHARS = 50;

/**
 * Per page, when the caller supplies `pageCount`. A scanned five-page card
 * statement carried 60 characters of stray header text in the R-591 corpus —
 * over the flat floor, and nowhere near a real text layer. A genuine
 * statement page runs to thousands of characters; 100 per page is a floor no
 * real text layer falls under and no scan reaches.
 */
export const DEFAULT_MIN_CHARS_PER_PAGE = 100;

function toMatcher(pattern) {
  if (pattern instanceof RegExp) return { test: (text) => pattern.test(text), source: String(pattern) };
  if (typeof pattern === 'string' && pattern.length > 0) {
    const needle = pattern.toLowerCase();
    return { test: (text) => text.toLowerCase().includes(needle), source: JSON.stringify(pattern) };
  }
  throw new TypeError(`fingerprint pattern must be a RegExp or a non-empty string, got ${JSON.stringify(pattern)}`);
}

export function createRegistry() {
  return { fingerprints: [] };
}

/**
 * Register one fingerprint. Returns the registry for chaining. Throws on a
 * duplicate id or a fingerprint with no `must` — a fingerprint that requires
 * nothing matches everything, which is the bug class this exists to prevent.
 */
export function registerFingerprint(registry, { id, must, mustNot = [], version = null, label = null }) {
  if (!id || typeof id !== 'string') throw new TypeError('fingerprint id is required');
  if (registry.fingerprints.some((f) => f.id === id)) throw new Error(`fingerprint "${id}" is already registered`);
  if (!Array.isArray(must) || must.length === 0) throw new Error(`fingerprint "${id}" must require at least one pattern`);
  registry.fingerprints.push({
    id,
    version,
    label,
    must: must.map(toMatcher),
    mustNot: mustNot.map(toMatcher),
  });
  return registry;
}

/**
 * Detect the layout of `text` against `registry`.
 * @returns {{ outcome: string, id: string|null, matches: string[], chars: number, evidence: object[] }}
 */
export function detect(text, registry, { minChars = DEFAULT_MIN_CHARS, minCharsPerPage = DEFAULT_MIN_CHARS_PER_PAGE, pageCount = null } = {}) {
  const body = typeof text === 'string' ? text : '';
  const chars = body.replace(/\s+/g, '').length;
  const pages = Number.isInteger(pageCount) && pageCount > 0 ? pageCount : null;
  const threshold = pages ? Math.max(minChars, minCharsPerPage * pages) : minChars;
  if (chars < threshold) {
    return { outcome: DETECT_OUTCOME.NO_TEXT, id: null, matches: [], chars, threshold, evidence: [] };
  }

  const evidence = [];
  const matches = [];
  for (const fp of registry.fingerprints) {
    const mustResults = fp.must.map((m) => ({ pattern: m.source, hit: m.test(body) }));
    const mustNotResults = fp.mustNot.map((m) => ({ pattern: m.source, hit: m.test(body) }));
    const matched = mustResults.every((r) => r.hit) && mustNotResults.every((r) => !r.hit);
    evidence.push({ id: fp.id, version: fp.version, matched, must: mustResults, mustNot: mustNotResults });
    if (matched) matches.push(fp.id);
  }

  if (matches.length === 1) return { outcome: DETECT_OUTCOME.MATCH, id: matches[0], matches, chars, threshold, evidence };
  if (matches.length === 0) return { outcome: DETECT_OUTCOME.UNKNOWN, id: null, matches, chars, threshold, evidence };
  return { outcome: DETECT_OUTCOME.AMBIGUOUS, id: null, matches, chars, threshold, evidence };
}
