/**
 * pc-credit-card.js — President's Choice Financial World Elite Mastercard.
 *
 * The text layer joins every word with two spaces, and page 1 interleaves the
 * transaction table with the Account summary column, so a row can read:
 *
 *   09/12  10/12  SQ  *CAFE  O  ROASTER  &  B  KITCHENER  ON  $28.80  Limit  $14,500.00  $7,250.00
 *   ELORA  HOME  HARDWARE  ELORA  ON  minimum  payment  by  its  due  date  each  month,  it  will
 *   10/12  11/12  $102.66
 *   08/01  09/01  PUNTA  ARENA  BEACH  CLUB  COCLE  002  USD  $12.95
 *   9.10  PAN  1.423076923  Limit  $14,500.00  $7,250.00
 *
 * THE ROW RULES, in order of appearance
 *   dated row      dd/mm dd/mm, then the description up to the FIRST money
 *                  figure, which is the amount; anything after the amount is
 *                  the summary column bleeding in and is dropped. A dated row
 *                  with NO description takes the previous row's leading
 *                  uppercase text (card-network merchant strings are upper
 *                  case; the summary column's prose is not). A dated row with
 *                  no money takes a bare money figure from the next row.
 *   FX detail      "9.10  PAN  1.423076923" — the original amount, its ISO
 *                  country and the rate. Appended to the previous item's
 *                  description (the original currency is what a budget wants
 *                  to see) and the item is categorised Foreign currency.
 *   "USD" alone    the currency marker wrapped to its own line; folded into
 *                  the previous item's description.
 *
 * Balance owed is positive; a payment is "-$5,963.51". Opening is "Previous
 * Balance", closing is "Statement balance", both in the Account summary.
 */

import {
  ParseError, collapse, parseMoney, parseLongDate, yearFor, isoDate, walk, findRow,
  rowKey, ignoredRows, finish, lineItem, HOLDER_LINE, required, round2,
} from './common.js';

export const ID = 'pc-world-elite-mastercard';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: 'text-layer 2026',
  label: "President's Choice Financial World Elite Mastercard statement",
  must: Object.freeze([/PC\s+World\s+Elite\s+Mastercard/i, /Statement\s+period:/i, /dd\/mm/]),
  mustNot: Object.freeze([]),
});

const DATED = /^(\d{2})\/(\d{2}) (\d{2})\/(\d{2})(?: (.*))?$/;
const MONEY = /(-|−)?\$\d{1,3}(?:,\d{3})*\.\d{2}(?:\s?CR)?|(-|−)?\$\d+\.\d{2}(?:\s?CR)?/;
const BARE_MONEY = /^(-|−)?\$\d[\d,]*\.\d{2}(?:\s?CR)?$/;
const FX_DETAIL = /^(\d[\d,]*\.\d{2}) ([A-Z]{3}) (\d+\.\d+)(?: (.*))?$/;

function classify(t) {
  // A foreign-currency detail row is folded into the item above it; it is
  // listed here as well because the summary column can bleed a date onto it
  // ("11.31  USA  1.408488063  Payment  due  date  May  29,  2026"), and a
  // dated amount row must be an item or explained — never silently consumed.
  if (FX_DETAIL.test(t)) return 'Foreign-currency detail (original amount, country, rate) for the item above; folded into its description';
  if (/^Statement balance: .*Statement period:/i.test(t)) return 'Statement header: statement balance and period; the balance is the section closing';
  if (/^Minimum payment: .*Payment due date:/i.test(t)) return 'Statement header: minimum payment and due date, not a transaction';
  if (/^Statement balance:|^Minimum payment:/i.test(t)) return 'Payment slip, not a transaction';
  if (/^Total payment activity\b/i.test(t)) return 'Subtotal of the payment section, not a transaction';
  if (/Previous Balance \$/i.test(t)) return 'Account summary: previous balance, carried as the section opening';
  if (/Statement Balance \$/i.test(t)) return 'Account summary: statement balance, carried as the section closing';
  if (/[+\-_] ?(Purchases|Cash Advances|Convenience cheques|Promotional balances|Interest|Fees|Other charges|Other credits) \$/i.test(t) || /Payments .{0,3}Thank you \$/i.test(t)) return 'Account summary totals, not transactions';
  if (/(Past due amount|Overlimit amount|Minimum payment|^Limit|^Available|Limit \$)/i.test(t)) return 'Account summary: dues and limits, not transactions';
  if (/^(Purchases|Cash Advances|Fees) \$[\d,.]+ \d+\.\d+ ?%/i.test(t)) return 'Interest rate table, not transactions';
  return null;
}

/**
 * The leading run of tokens that carry no lowercase letter — a merchant
 * string, never the summary column's prose. The run must look like a merchant
 * (two or more tokens, at least one word of three or more letters) and must
 * not carry a figure or a summary operator, so an account-number row or a
 * "+ Fees $0.00" row never becomes a description.
 */
function leadingUppercase(t) {
  const out = [];
  for (const tok of t.split(' ')) {
    if (/[a-z]/.test(tok)) break;
    out.push(tok);
  }
  const run = out.join(' ');
  if (out.length < 2 || /[$+_]/.test(run) || !/\b[A-Z]{3,}\b/.test(run)) return null;
  return run;
}

export function parse(pages) {
  const layout = ID;

  const headRow = required(findRow(pages, /Statement balance:\s*(\S+)\s+Statement period:\s*(.+?)\s*-\s*(.+)$/i), layout, 'the statement header (balance and period)');
  const closing = parseMoney(headRow.match[1]);
  const period = { start: parseLongDate(headRow.match[2]), end: parseLongDate(headRow.match[3]) };
  if (closing === null || !period.start || !period.end) throw new ParseError(`${layout}: statement header "${headRow.row}" did not yield a balance and two dates`);

  const openingRow = required(findRow(pages, /Previous Balance (\S+(?: CR)?)(?:\s|$)/i), layout, 'the previous balance');
  const opening = parseMoney(openingRow.match[1]);
  if (opening === null) throw new ParseError(`${layout}: previous balance "${openingRow.row}" is not a figure`);

  const acctRow = required(findRow(pages, /Account number:\s*(.+)$/i), layout, 'the account number');
  const accountNumber = acctRow.match[1].trim();

  const dateRow = required(findRow(pages, /^Statement date:/i), layout, 'the statement date');
  const holderText = dateRow.index > 0 ? collapse(pages[dateRow.page - 1][dateRow.index - 1]) : '';
  const holderMatch = HOLDER_LINE.exec(holderText);
  if (!holderMatch) throw new ParseError(`${layout}: the line before "Statement date" is not a cardholder name: "${holderText}"`);
  const holders = [holderMatch[1]];

  const consumed = new Set();
  const items = [];
  let sequence = 0;
  let lastItem = null;

  for (const [pi, rows] of pages.entries()) {
    const page = pi + 1;
    let pending = null; // the previous row's merchant text, for a dated row with no description
    for (let i = 0; i < rows.length; i++) {
      const c = collapse(rows[i]);
      const dated = DATED.exec(c);
      if (dated) {
        const rest = dated[5] || '';
        const money = MONEY.exec(rest);
        let description;
        let amount;
        if (money) {
          description = rest.slice(0, money.index).trim();
          amount = parseMoney(money[0]);
        } else {
          description = rest.trim();
          const next = i + 1 < rows.length ? collapse(rows[i + 1]) : '';
          if (!BARE_MONEY.test(next)) throw new ParseError(`${layout}: page ${page} row ${i} is dated but carries no amount and none follows: "${rows[i]}"`, { page, index: i });
          amount = parseMoney(next);
          consumed.add(rowKey(page, i + 1));
          i += 1;
        }
        if (description.length === 0) {
          if (!pending) throw new ParseError(`${layout}: page ${page} row ${i} is a dated amount with no description and none on the row before: "${rows[i]}"`, { page, index: i });
          description = pending;
        }
        if (amount === null) throw new ParseError(`${layout}: page ${page} row ${i}: amount unreadable: "${rows[i]}"`, { page, index: i });
        const month = Number(dated[2]);
        const day = Number(dated[1]);
        const postMonth = Number(dated[4]);
        const postDay = Number(dated[3]);
        const item = lineItem({
          date: isoDate(yearFor(month, day, period), month, day),
          effectiveDate: isoDate(yearFor(postMonth, postDay, period), postMonth, postDay),
          description,
          amount,
          page,
          sequence: sequence++,
          category: /^PAYMENT\b/i.test(description) && amount < 0 ? 'Payment' : /INTEREST CHARGE/i.test(description) ? 'Interest' : null,
        });
        items.push(item);
        lastItem = item;
        consumed.add(rowKey(page, i));
        pending = null;
        continue;
      }
      const fx = FX_DETAIL.exec(c);
      if (fx) {
        if (!lastItem) throw new ParseError(`${layout}: page ${page} row ${i} is a foreign-currency detail with no item before it: "${rows[i]}"`, { page, index: i });
        lastItem.description = `${lastItem.description}  ${fx[1]} ${fx[2]} ${fx[3]}`;
        lastItem.category = 'Foreign currency';
        // Not consumed: classify() lists it as ignored, so the coverage check
        // sees it even when the summary column bleeds a date onto it.
        pending = null;
        continue;
      }
      if (/^[A-Z]{3}$/.test(c) && lastItem) {
        if (!/ [A-Z]{3}$/.test(lastItem.description)) lastItem.description = `${lastItem.description} ${c}`;
        pending = null;
        continue;
      }
      // The merchant of a split row can share its line with summary bleed
      // that carries a figure ("ANTHROPIC SAN FRANCISCOCA USD Overlimit amount
      // $0.00"); the leading uppercase run is still the merchant.
      pending = leadingUppercase(c);
    }
  }

  const ignored = ignoredRows(pages, { consumed, classify, layout });

  return finish({
    layout, issuer: "President's Choice Financial", documentType: 'credit-card', period,
    sections: [{
      identity: { accountNumber, holders, label: 'PC World Elite Mastercard' },
      period: { ...period },
      opening: { balance: round2(opening), printed: true },
      closing: { balance: round2(closing), printed: true },
      items,
      positions: null,
    }],
    ignored,
  });
}
