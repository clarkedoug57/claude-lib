/**
 * @claude-lib/statement-model — the canonical statement shape and its proof.
 *
 *   STATEMENT_SCHEMA        the model, as JSON Schema (schema.js)
 *   validateStatement(x)    { ok, errors[] } — structural validity only; the
 *                           ARITHMETIC lives in statement-core.reconcile and
 *                           the layout agent's verifier composes both
 *   statementToolSchema()   the strict tool input_schema for a model that
 *                           proposes a Statement — the same object, frozen
 *   sectionToReconcileInput(section)
 *                           the one mapping from a canonical section to the
 *                           reconcile gate's { opening, closing, items }
 */

import { STATEMENT_SCHEMA, ACCOUNT_SECTION_SCHEMA, LINE_ITEM_SCHEMA, IGNORED_ROW_SCHEMA } from './schema.js';
import { validateAgainst } from './validate.js';

export { STATEMENT_SCHEMA, ACCOUNT_SECTION_SCHEMA, LINE_ITEM_SCHEMA, IGNORED_ROW_SCHEMA, validateAgainst };

export function validateStatement(statement) {
  return validateAgainst(STATEMENT_SCHEMA, statement);
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

/**
 * Keywords a strict tool schema does not accept (the API rejects `minimum` on
 * an integer with a 400; the numeric/length constraints are all in that
 * class). They stay in the MODEL for the validator, which runs on every
 * proposal anyway — so nothing is lost, only moved from the model's side of
 * the wire to ours.
 */
export const STRICT_UNSUPPORTED_KEYWORDS = Object.freeze(['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern']);

function stripForStrict(node) {
  if (Array.isArray(node)) return node.map(stripForStrict);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (STRICT_UNSUPPORTED_KEYWORDS.includes(k)) continue;
      out[k] = stripForStrict(v);
    }
    return out;
  }
  return node;
}

/** Any JSON-Schema object → the strict-tool form (constraints stripped, frozen). */
export function toStrictToolSchema(schema) {
  return deepFreeze(stripForStrict(JSON.parse(JSON.stringify(schema))));
}

const TOOL_SCHEMA = toStrictToolSchema(STATEMENT_SCHEMA);

/** The strict tool's input_schema: the model, constraints stripped, frozen. */
export function statementToolSchema() {
  return TOOL_SCHEMA;
}

/**
 * Map one AccountSection to the reconcile gate's input. The section's items
 * already carry the SIGNED amount, so no vocabulary is applied here — that is
 * the whole point of the canonical model. `printed` on the closing anchor lets
 * the gate trust the running balances when the issuer printed the close.
 */
export function sectionToReconcileInput(section) {
  const items = (section.items || []).map((it, i) => ({
    id: `${section.identity?.accountNumber || 'section'}:${it.sequence ?? i}`,
    kind: 'line',
    date: it.date,
    sequence: String(it.sequence ?? i).padStart(6, '0'),
    amount: it.amount,
    runningBalance: it.runningBalance ?? null,
  }));
  const positionsOf = (list) => (list || []).map((p) => ({ symbol: p.symbol, quantity: p.quantity, price: p.price ?? undefined }));
  return {
    opening: { balance: section.opening.balance, positions: positionsOf(section.positions?.opening) },
    closing: { balance: section.closing.balance, printed: section.closing.printed === true, positions: positionsOf(section.positions?.closing) },
    items,
  };
}
