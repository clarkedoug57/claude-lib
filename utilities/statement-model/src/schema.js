/**
 * schema.js — the canonical statement model, written ONCE as a JSON Schema.
 *
 * class: utility. Zero dependencies. Knows no issuer, no app vocabulary.
 *
 * Three consumers read this one object:
 *   - the validator (validate.js), which walks it;
 *   - the layout agent's strict tool, whose input_schema IS this object — so a
 *     model cannot propose a shape the gate cannot check;
 *   - the fixture format, which stores proposals in exactly this shape.
 *
 * THE MODEL
 *   Statement
 *     issuer         the institution as printed ("Simplii Financial")
 *     documentType   what kind of statement this is — an open vocabulary
 *                    ("chequing", "credit-card", "line-of-credit", "investment")
 *     currency       ISO-4217 code of every amount in the document
 *     period         { start, end }  ISO dates, inclusive
 *     sections       one AccountSection per account the document reports
 *     ignored        every dated or amount-bearing row NOT used as an item,
 *                    each with a reason — the coverage list
 *
 *   AccountSection
 *     identity       { accountNumber, holders[], label }  as printed
 *     period         optional override of the statement period
 *     opening        { balance, printed }  the issuer's own figure
 *     closing        { balance, printed }
 *     items          LineItem[], in print order
 *     positions      optional { opening[], closing[] } for investment accounts
 *
 *   LineItem
 *     date           the date the issuer's period totals use (ISO)
 *     effectiveDate  optional second date (posting / effective)
 *     description    as printed
 *     amount         SIGNED: positive INCREASES the tracked balance. For a
 *                    deposit account funds in are +; for a card or a line of
 *                    credit tracked as an amount owed, a purchase is + and a
 *                    payment is −. The sign convention is the section's, and
 *                    the gate proves it: opening + Σ amount must equal closing.
 *     runningBalance optional — the issuer's printed balance after the line
 *     page           1-based page the line was read from
 *     sequence       print order within the section, 0-based
 *     category       optional — the issuer's own hint, never authority
 *
 * Every object carries additionalProperties:false and a complete `required`
 * list, because the strict tool demands both. Optional fields are therefore
 * expressed as nullable (type: [T, 'null']) and still required — a proposal
 * says "no running balance" explicitly, never by omission.
 */

const ISO_DATE = '^\\d{4}-\\d{2}-\\d{2}$';

const period = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: { type: 'string', pattern: ISO_DATE },
    end: { type: 'string', pattern: ISO_DATE },
  },
};

const balanceAnchor = {
  type: 'object',
  additionalProperties: false,
  required: ['balance', 'printed'],
  properties: {
    balance: { type: 'number' },
    printed: { type: 'boolean' },
  },
};

const position = {
  type: 'object',
  additionalProperties: false,
  required: ['symbol', 'quantity', 'price'],
  properties: {
    symbol: { type: 'string', minLength: 1 },
    quantity: { type: 'number' },
    price: { type: ['number', 'null'] },
  },
};

export const LINE_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['date', 'effectiveDate', 'description', 'amount', 'runningBalance', 'page', 'sequence', 'category'],
  properties: {
    date: { type: 'string', pattern: ISO_DATE },
    effectiveDate: { type: ['string', 'null'], pattern: ISO_DATE },
    description: { type: 'string' },
    amount: { type: 'number' },
    runningBalance: { type: ['number', 'null'] },
    page: { type: 'integer', minimum: 1 },
    sequence: { type: 'integer', minimum: 0 },
    category: { type: ['string', 'null'] },
  },
};

export const ACCOUNT_SECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['identity', 'period', 'opening', 'closing', 'items', 'positions'],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['accountNumber', 'holders', 'label'],
      properties: {
        accountNumber: { type: 'string', minLength: 1 },
        holders: { type: 'array', items: { type: 'string' } },
        label: { type: ['string', 'null'] },
      },
    },
    period: { ...period, type: ['object', 'null'] },
    opening: balanceAnchor,
    closing: balanceAnchor,
    items: { type: 'array', items: LINE_ITEM_SCHEMA },
    positions: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['opening', 'closing'],
      properties: {
        opening: { type: 'array', items: position },
        closing: { type: 'array', items: position },
      },
    },
  },
};

export const IGNORED_ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['page', 'text', 'reason'],
  properties: {
    page: { type: 'integer', minimum: 1 },
    text: { type: 'string', minLength: 1 },
    reason: { type: 'string', minLength: 1 },
  },
};

export const STATEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['issuer', 'documentType', 'currency', 'period', 'sections', 'ignored'],
  properties: {
    issuer: { type: 'string', minLength: 1 },
    documentType: { type: 'string', minLength: 1 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    period,
    sections: { type: 'array', minItems: 1, items: ACCOUNT_SECTION_SCHEMA },
    ignored: { type: 'array', items: IGNORED_ROW_SCHEMA },
  },
};
