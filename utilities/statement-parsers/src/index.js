/**
 * @claude-lib/statement-parsers — six deterministic parsers, one per layout.
 *
 *   PARSERS                       { [id]: { id, fingerprint, parse } } — frozen
 *   PARSER_IDS                    the six ids
 *   registerParsers(registry)     register every fingerprint on a statement-detect registry
 *   createParserRegistry()        a fresh registry carrying the six
 *   parseDocument(pages, opts?)   detect, then parse: { detection, statement } — statement is
 *                                 null unless detection is a match; a parser refusal propagates
 *   ParseError                    what a parser throws when it refuses
 *
 * A parser takes the extractor's rows per page (string[][]) — the same rows a
 * staged fixture stores — and returns a canonical Statement that has already
 * validated against the model and reconciled to the cent. A parser never
 * guesses: an unplaceable dated amount row, a missing header, a balance that
 * does not chain, are each a ParseError naming the page and row.
 *
 * Each layout module exports ID, FINGERPRINT and parse. The fingerprints are
 * mutually exclusive on the R-593 corpus by construction (form codes and
 * product names, never a phrase two layouts share), and the test file proves
 * every fixture routes to exactly its own id.
 */

import { createRegistry, registerFingerprint, detect, DETECT_OUTCOME } from '../../statement-detect/src/index.js';
import * as simpliiChequing from './simplii-chequing.js';
import * as simpliiLineOfCredit from './simplii-line-of-credit.js';
import * as simpliiCreditCard from './simplii-credit-card.js';
import * as pcCreditCard from './pc-credit-card.js';
import * as tdLineOfCredit from './td-line-of-credit.js';
import * as tdCreditCard from './td-credit-card.js';

export { ParseError } from './common.js';

const MODULES = [simpliiChequing, simpliiLineOfCredit, simpliiCreditCard, pcCreditCard, tdLineOfCredit, tdCreditCard];

export const PARSERS = Object.freeze(Object.fromEntries(
  MODULES.map((m) => [m.ID, Object.freeze({ id: m.ID, fingerprint: m.FINGERPRINT, parse: m.parse })]),
));

export const PARSER_IDS = Object.freeze(MODULES.map((m) => m.ID));

export function registerParsers(registry) {
  for (const id of PARSER_IDS) registerFingerprint(registry, { ...PARSERS[id].fingerprint, must: [...PARSERS[id].fingerprint.must], mustNot: [...(PARSERS[id].fingerprint.mustNot || [])] });
  return registry;
}

export function createParserRegistry() {
  return registerParsers(createRegistry());
}

/**
 * Detect the layout of `pages` and parse it with the matching parser.
 * @param {string[][]} pages
 * @param {{ registry?: object }} [opts]  a registry to detect against (default: the six)
 * @returns {{ detection: object, statement: object|null }}
 */
export function parseDocument(pages, { registry = null } = {}) {
  const text = (pages || []).map((rows) => (rows || []).join('\n')).join('\n');
  const detection = detect(text, registry || createParserRegistry(), { pageCount: (pages || []).length });
  if (detection.outcome !== DETECT_OUTCOME.MATCH || !PARSERS[detection.id]) return { detection, statement: null };
  return { detection, statement: PARSERS[detection.id].parse(pages) };
}
