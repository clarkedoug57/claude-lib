/**
 * verifier.js — none of it is the model.
 *
 * Four checks, all mechanical, all complete (every failure listed, never the
 * first only, because the list goes back to the model as its correction):
 *
 *   1. schema      the proposal validates against the canonical model
 *   2. arithmetic  every section reconciles: opening + Σ amount = closing, to
 *                  the cent, through statement-core.reconcile (the running-
 *                  balance path cross-checks when the issuer printed one).
 *                  The only way a hallucinated or misread line survives this
 *                  is by exactly cancelling another — which check 3 exposes.
 *   3. coverage    every row of the source that carries a date AND an amount is
 *                  either an item (an item on that page carries one of the
 *                  row's amounts) or is listed in ignored[] with a reason. A
 *                  page with amounts and no items is a failure, never silence.
 *   4. identity    each section's account number appears verbatim in the
 *                  source; the statement's period end appears in some printed
 *                  form; every PRINTED opening/closing balance appears as a
 *                  figure on the page. A model cannot invent an account, a
 *                  period, or an anchor.
 *
 * SOURCE
 *   { pages: string[][] }  the extracted rows per page (text-layer documents),
 *   or the model's own transcription for an image-only document — in which
 *   case checks 3 and 4 prove the proposal against the transcription, and the
 *   transcription is proven against the page only by the arithmetic (a
 *   transcription whose ≈70 amounts sum to the printed purchases total to the
 *   cent is not a hallucination). The result says which source it used.
 */

import { validateStatement, sectionToReconcileInput } from '../../../utilities/statement-model/src/index.js';
import { reconcile, RECONCILE_STATUS } from '../../../utilities/statement-core/src/index.js';

export const FAILURE = Object.freeze({
  SCHEMA: 'schema',
  OUT_OF_BALANCE: 'out-of-balance',
  UNVERIFIABLE: 'unverifiable',
  UNCOVERED_ROW: 'uncovered-row',
  EMPTY_PAGE_WITH_AMOUNTS: 'page-with-amounts-no-items',
  ACCOUNT_NOT_IN_SOURCE: 'account-not-in-source',
  PERIOD_NOT_IN_SOURCE: 'period-not-in-source',
  ANCHOR_NOT_IN_SOURCE: 'anchor-not-in-source',
  NO_SOURCE: 'no-source',
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_TOKEN = new RegExp(`\\b(?:(?:${MONTH_RE})\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+(?:${MONTH_RE})\\b|\\b\\d{2}/\\d{2}(?:/\\d{2,4})?\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b)`, 'i');
const MONEY_TOKEN = /(?<![\d.])-?\$?\d{1,3}(?:,\d{3})*\.\d{2}(?:-|CR)?(?![\d])|(?<![\d.,])-?\$?\d+\.\d{2}(?:-|CR)?(?![\d])/g;

/** Every money magnitude on a row, as numbers rounded to cents. */
export function moneyValues(row) {
  const out = [];
  for (const m of String(row).matchAll(MONEY_TOKEN)) {
    const n = Number(m[0].replace(/[$,\-]|CR/g, ''));
    if (Number.isFinite(n)) out.push(Math.round(n * 100) / 100);
  }
  return out;
}

export function hasDateToken(row) {
  return DATE_TOKEN.test(String(row));
}

const cents = (n) => Math.round(Math.abs(Number(n) || 0) * 100);

/** Printed forms an ISO date might take on a page. */
export function printedDateForms(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return [];
  const [, y, mm, dd] = m;
  const month = MONTHS[Number(mm) - 1];
  const short = month.slice(0, 3);
  const d = String(Number(dd));
  return [
    iso,
    `${month} ${d}, ${y}`, `${short} ${d}, ${y}`, `${short}. ${d}, ${y}`,
    `${month} ${d} ${y}`, `${short} ${d} ${y}`,
    `${d} ${month} ${y}`, `${d} ${short} ${y}`, `${dd} ${short} ${y}`,
    `${month} ${d}`, `${short} ${d}`, `${short}. ${d}`, `${d} ${month}`, `${d} ${short}`,
    `${dd}/${mm}/${y}`, `${mm}/${dd}/${y}`, `${dd}/${mm}`, `${mm}/${dd}`,
    `${y}/${mm}/${dd}`, `${dd}${short}${y.slice(2)}`, `${d}${short}${y}`,
  ];
}

function normalise(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Money as it might be printed: 1,234.56 / 1234.56 / 1,234.56- / $1,234.56 / 1,234.56CR — matched by magnitude on the page. */
function figureAppears(value, pageText) {
  const target = cents(value);
  if (target === 0) return true; // a zero balance is rarely printed as "0.00"; do not fail on it
  for (const v of moneyValues(pageText)) if (cents(v) === target) return true;
  return false;
}

/**
 * Verify a proposal against a source.
 * @returns {{ ok: boolean, failures: object[], sections: object[], sourceKind: string }}
 */
export function verifyProposal(statement, source = {}) {
  const failures = [];
  const pages = Array.isArray(source.pages) && source.pages.length > 0 ? source.pages : null;
  const sourceKind = source.kind || (pages ? 'text' : 'none');

  // 1. schema — if it fails, nothing below can be trusted; return early.
  const schema = validateStatement(statement);
  if (!schema.ok) {
    for (const e of schema.errors) failures.push({ code: FAILURE.SCHEMA, path: e.path, message: e.message });
    return { ok: false, failures, sections: [], sourceKind };
  }

  // 2. arithmetic, per section
  const sections = statement.sections.map((section, i) => {
    const r = reconcile(sectionToReconcileInput(section));
    const label = section.identity.accountNumber;
    if (r.status === RECONCILE_STATUS.OUT_OF_BALANCE || r.balance.status === 'out-of-balance') {
      failures.push({
        code: FAILURE.OUT_OF_BALANCE, section: i, account: label,
        opening: r.balance.opening, sumOfItems: Math.round((r.balance.computed - r.balance.opening) * 100) / 100,
        computed: r.balance.computed, closing: r.balance.closing, variance: r.balance.variance, path: r.balance.path,
        message: `section ${i} (${label}): opening ${r.balance.opening} + Σ items = ${r.balance.computed}, closing is ${r.balance.closing}, variance ${r.balance.variance} (${r.balance.path})`,
      });
    } else if (r.status === RECONCILE_STATUS.UNVERIFIABLE) {
      failures.push({ code: FAILURE.UNVERIFIABLE, section: i, account: label, message: `section ${i} (${label}): unverifiable — ${JSON.stringify(r.balance.unknownKinds || [])}` });
    }
    return { section: i, account: label, reconcile: r };
  });

  if (!pages) {
    failures.push({ code: FAILURE.NO_SOURCE, message: 'no source rows to prove coverage or identity against — for an image-only document, transcribe the pages first' });
    return { ok: false, failures, sections, sourceKind };
  }

  // 3. coverage
  const itemCentsByPage = new Map();
  for (const section of statement.sections) {
    for (const it of section.items) {
      if (!itemCentsByPage.has(it.page)) itemCentsByPage.set(it.page, new Set());
      itemCentsByPage.get(it.page).add(cents(it.amount));
      if (it.runningBalance != null) itemCentsByPage.get(it.page).add(cents(it.runningBalance));
    }
  }
  const anchorCents = new Set();
  for (const section of statement.sections) {
    anchorCents.add(cents(section.opening.balance));
    anchorCents.add(cents(section.closing.balance));
  }
  const ignoredByPage = new Map();
  for (const row of statement.ignored) {
    if (!ignoredByPage.has(row.page)) ignoredByPage.set(row.page, []);
    ignoredByPage.get(row.page).push(normalise(row.text));
  }

  pages.forEach((rows, pi) => {
    const page = pi + 1;
    const pageItems = itemCentsByPage.get(page) || new Set();
    const pageIgnored = ignoredByPage.get(page) || [];
    let amountRows = 0;
    for (const row of rows || []) {
      const values = moneyValues(row);
      if (values.length === 0 || !hasDateToken(row)) continue;
      amountRows += 1;
      const explainedByItem = values.some((v) => pageItems.has(cents(v)));
      const explainedByAnchor = values.some((v) => anchorCents.has(cents(v)));
      const n = normalise(row);
      const explainedByIgnore = pageIgnored.some((ig) => ig.length >= 4 && (n.includes(ig) || ig.includes(n)));
      if (!explainedByItem && !explainedByAnchor && !explainedByIgnore) {
        failures.push({ code: FAILURE.UNCOVERED_ROW, page, text: String(row).slice(0, 160), message: `page ${page}: dated row with an amount is neither an item nor listed as ignored: "${String(row).slice(0, 120)}"` });
      }
    }
    if (amountRows > 0 && pageItems.size === 0 && pageIgnored.length === 0) {
      failures.push({ code: FAILURE.EMPTY_PAGE_WITH_AMOUNTS, page, message: `page ${page}: carries ${amountRows} dated amount row(s) but the proposal has no items and no ignored rows on it` });
    }
  });

  // 4. identity
  const allText = pages.map((rows) => (rows || []).join('\n')).join('\n');
  const allNorm = normalise(allText);
  for (const [i, section] of statement.sections.entries()) {
    const acct = normalise(section.identity.accountNumber);
    const acctDigits = acct.replace(/\D/g, '');
    const appears = acct.length > 0 && (allNorm.includes(acct) || (acctDigits.length >= 4 && allNorm.replace(/\D/g, '').includes(acctDigits)));
    if (!appears) {
      failures.push({ code: FAILURE.ACCOUNT_NOT_IN_SOURCE, section: i, account: section.identity.accountNumber, message: `section ${i}: account number "${section.identity.accountNumber}" does not appear in the source` });
    }
    for (const [which, anchor] of [['opening', section.opening], ['closing', section.closing]]) {
      if (anchor.printed && !figureAppears(anchor.balance, allText)) {
        failures.push({ code: FAILURE.ANCHOR_NOT_IN_SOURCE, section: i, account: section.identity.accountNumber, anchor: which, balance: anchor.balance, message: `section ${i}: ${which} balance ${anchor.balance} is marked printed but no such figure appears in the source` });
      }
    }
  }
  const endForms = printedDateForms(statement.period.end).map(normalise);
  if (!endForms.some((f) => allNorm.includes(f))) {
    failures.push({ code: FAILURE.PERIOD_NOT_IN_SOURCE, message: `period end ${statement.period.end} appears in none of its printed forms in the source` });
  }

  return { ok: failures.length === 0, failures, sections, sourceKind };
}

/** A compact, model-facing rendering of a failure list. */
export function describeFailures(failures) {
  return failures.map((f, i) => `${i + 1}. [${f.code}] ${f.message}`).join('\n');
}
