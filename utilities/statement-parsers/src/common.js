/**
 * common.js — what every layout parser shares, and nothing a layout owns.
 *
 * class: utility. Zero dependencies. Imports only statement-model (the shape
 * every parser must produce) and statement-core (the gate every parser must
 * pass before it returns).
 *
 * THE PARSER CONTRACT
 *   parse(pages: string[][], options?) → Statement
 *     pages   the extractor's rows per page — the same rows a staged fixture
 *             stores under raw.pages, so a parser is proven on exactly the
 *             input it will see
 *     throws  ParseError. A parser never guesses: a dated row carrying an
 *             amount that it cannot place as an item and cannot classify as a
 *             known non-transaction row is a REFUSAL, because that row is the
 *             signature of a layout revision the parser does not know. A
 *             section that does not reconcile to the cent is a refusal too —
 *             the gate runs inside parse(), so a Statement that comes back is
 *             already balanced.
 *
 * REDACTION INVARIANCE
 *   Fixtures are redacted by construction (statement-fixtures): holders become
 *   HOLDER-n, addresses become REDACTED, long digit runs are masked to ····nnnn
 *   and card numbers to 4520 XXXX XXXX 9734. A parser is tested on those rows
 *   and must read them exactly as it reads the originals, so every identity
 *   pattern here admits the masked forms. That is the one place the parsers
 *   know the fixture format exists.
 *
 * `hasDateToken` mirrors the layout agent's verifier on purpose: a utility may
 * not import an agent, and the two must agree on what "a dated row" is.
 */

import { validateStatement } from '../../statement-model/src/index.js';
import { sectionToReconcileInput } from '../../statement-model/src/index.js';
import { reconcile, RECONCILE_STATUS } from '../../statement-core/src/index.js';

export class ParseError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ParseError';
    this.detail = detail;
  }
}

// ── text ────────────────────────────────────────────────────────────────────

/** Collapse runs of whitespace to one space and trim. */
export const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Split an extractor row on its column gaps (two or more spaces). */
export const cells = (row) => String(row ?? '').trim().split(/\s{2,}/).filter((c) => c.length > 0);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 'Jan' / 'JAN' / 'January' / 'Sept.' → 1..12, or null. */
export function monthIndex(name) {
  const key = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  const i = MONTHS.indexOf(key);
  return i === -1 ? null : i + 1;
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
export const round2 = (n) => Math.round(Number(n) * 100) / 100;

const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_TOKEN = new RegExp(`\\b(?:(?:${MONTH_RE})\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${MONTH_RE})\\b|\\b\\d{2}/\\d{2}(?:/\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b)`, 'i');

/** The verifier's definition of a dated row. Kept identical on purpose. */
export function hasDateToken(row) {
  return DATE_TOKEN.test(String(row ?? ''));
}

/**
 * A printed money figure, every form the six layouts use:
 *   1,234.56   $1,234.56   -$1,234.56   −$1,234.56   1,234.56-   $1.49 CR   1.49CR
 * Returns { value, raw } with the SIGN applied (a trailing minus or CR is a
 * credit), or null when the token is not money.
 */
const MONEY_TOKEN = /(?<![\d.])(-|−)?\$?\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})(?:\s?(-|CR))?(?![\d])/g;

export function moneyTokens(row) {
  const out = [];
  for (const m of String(row ?? '').matchAll(MONEY_TOKEN)) {
    const magnitude = Number(m[2].replace(/,/g, ''));
    if (!Number.isFinite(magnitude)) continue;
    const negative = Boolean(m[1]) || Boolean(m[3]);
    out.push({ value: round2(negative ? -magnitude : magnitude), raw: m[0], index: m.index });
  }
  return out;
}

/** The one money figure a token must be, or null. */
export function parseMoney(token) {
  const t = String(token ?? '').trim();
  const found = moneyTokens(t);
  if (found.length !== 1) return null;
  // The whole token must be the figure (allowing $, sign, CR and spaces).
  const stripped = t.replace(/[\s$,]/g, '').replace(/^[-−]/, '').replace(/(-|CR)$/, '');
  if (!/^\d+\.\d{2}$/.test(stripped)) return null;
  return found[0].value;
}

// ── dates ───────────────────────────────────────────────────────────────────

/**
 * 'July 30, 2026' / 'Sept. 8, 2026' / 'January 09, 2026' / 'Dec. 9, 2025' → ISO.
 * Tolerates a broken first letter ("M arch") — the TD extractor splits some
 * words at their kerning boundary.
 */
export function parseLongDate(text) {
  const t = collapse(text).replace(/\b([A-Z]) ([a-z])/g, '$1$2');
  const m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (!m) return null;
  const month = monthIndex(m[1]);
  if (!month) return null;
  return isoDate(m[3], month, m[2]);
}

/**
 * The year for a month/day printed without one, given the section's period:
 * whichever of the period's two years puts the date nearest the period.
 * A statement period never spans more than two calendar years.
 */
export function yearFor(month, day, period) {
  const startYear = Number(period.start.slice(0, 4));
  const endYear = Number(period.end.slice(0, 4));
  if (startYear === endYear) return startYear;
  const candidates = [startYear, endYear].map((y) => isoDate(y, month, day));
  const distance = (iso) => {
    if (iso < period.start) return daysBetween(iso, period.start);
    if (iso > period.end) return daysBetween(period.end, iso);
    return 0;
  };
  return distance(candidates[0]) <= distance(candidates[1]) ? startYear : endYear;
}

function daysBetween(a, b) {
  return Math.abs((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 'Jul 31' / 'JAN 5' with a period → ISO. Null when it is not a month-day. */
export function monthDayToIso(text, period) {
  const m = /^([A-Za-z]{3,})\.?\s+(\d{1,2})$/.exec(collapse(text));
  if (!m) return null;
  const month = monthIndex(m[1]);
  if (!month) return null;
  return isoDate(yearFor(month, Number(m[2]), period), month, m[2]);
}

// ── walking rows ────────────────────────────────────────────────────────────

/** Every row with its page (1-based) and index, in print order. */
export function* walk(pages) {
  for (const [pi, rows] of (pages || []).entries()) {
    for (const [ri, row] of (rows || []).entries()) {
      yield { page: pi + 1, index: ri, row: String(row ?? '') };
    }
  }
}

/** First row whose collapsed text matches `re`; { page, index, row, match } or null. */
export function findRow(pages, re) {
  for (const r of walk(pages)) {
    const match = re.exec(collapse(r.row));
    if (match) return { ...r, match };
  }
  return null;
}

export const rowKey = (page, index) => `${page}:${index}`;

// ── the ignored list and the refusal rule ───────────────────────────────────

/**
 * Every amount-bearing row that is not an item becomes an ignored entry with a
 * reason — or a refusal. `classify(rowText)` returns the reason for a row the
 * layout knows is not a transaction, or null. An unclassified row that carries
 * a DATE and an amount is the refusal: that is exactly the row the coverage
 * check would flag, and exactly the row a layout revision produces. An
 * unclassified, undated amount row is listed with an honest generic reason —
 * it can never be a missed transaction, because every transaction is dated.
 */
export function ignoredRows(pages, { consumed, classify, layout }) {
  const ignored = [];
  for (const r of walk(pages)) {
    if (consumed.has(rowKey(r.page, r.index))) continue;
    if (moneyTokens(r.row).length === 0) continue;
    const text = r.row.trim();
    const reason = classify(collapse(text), r);
    if (reason) {
      ignored.push({ page: r.page, text, reason });
    } else if (hasDateToken(text)) {
      throw new ParseError(`${layout}: page ${r.page} row ${r.index} carries a date and an amount but is neither a transaction nor a known non-transaction row: "${text.slice(0, 140)}"`, { page: r.page, index: r.index, text });
    } else {
      ignored.push({ page: r.page, text, reason: 'Undated amount outside the transaction table (summary, limit, rate or slip), not a transaction' });
    }
  }
  return ignored;
}

// ── assembling and proving ──────────────────────────────────────────────────

/**
 * Build the canonical Statement, validate it against the model, and run every
 * section through the gate. Throws ParseError on either failure, naming the
 * section and the variance — a parser that returns has already balanced.
 */
export function finish({ layout, issuer, documentType, currency = 'CAD', period, sections, ignored }) {
  const statement = { issuer, documentType, currency, period, sections, ignored };
  const v = validateStatement(statement);
  if (!v.ok) {
    throw new ParseError(`${layout}: the parsed statement does not validate against the model: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`, { errors: v.errors });
  }
  for (const [i, section] of sections.entries()) {
    const r = reconcile(sectionToReconcileInput(section));
    if (r.status !== RECONCILE_STATUS.BALANCED) {
      throw new ParseError(`${layout}: section ${i} (${section.identity.accountNumber}) does not reconcile — opening ${r.balance.opening} + Σ items = ${r.balance.computed}, closing ${r.balance.closing}, variance ${r.balance.variance} (${r.balance.path})`, { section: i, balance: r.balance });
    }
  }
  return statement;
}

/** A LineItem with every model field present (nulls explicit). */
export function lineItem({ date, effectiveDate = null, description, amount, runningBalance = null, page, sequence, category = null }) {
  return { date, effectiveDate, description, amount: round2(amount), runningBalance: runningBalance == null ? null : round2(runningBalance), page, sequence, category };
}

/** A holder line as printed, or the HOLDER-n placeholder a fixture carries. */
export const HOLDER_LINE = /^(?:OR\s+)?(?!REDACTED$)(HOLDER-\d+|[A-Z][A-Z .'\-]{1,60})$/;

/** Require a match or refuse, so a missing header is named rather than defaulted. */
export function required(found, layout, what) {
  if (!found) throw new ParseError(`${layout}: ${what} not found`, { what });
  return found;
}
