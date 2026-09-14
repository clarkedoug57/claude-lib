/**
 * td-credit-card.js — TD Cash Back Visa Card statement.
 *
 *   TRANSACTION  POSTING
 *   DATE  DATE  ACTIVITY  DESCRIPTION  AMOUNT($)
 *   PREVIOUS  STATEMENT  BALANCE  $5.48
 *   JAN 5  JAN 6  PAYMENT - THANK YOU  -$5.48
 *   JAN 9  JAN 9  RETAIL INTEREST  $0.09
 *   TOTAL  NEW  BALANCE  $0.09
 *
 * Every word is its own extractor token, so rows are read collapsed. The
 * payment-information column bleeds onto the same rows on the right; a
 * transaction row is cut at its amount. Balance owed is positive; a payment
 * or credit is "-$5.48" as printed.
 */

import {
  ParseError, collapse, parseMoney, parseLongDate, monthDayToIso, walk, findRow,
  rowKey, ignoredRows, finish, lineItem, HOLDER_LINE, required, round2,
} from './common.js';

export const ID = 'td-cash-back-visa';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: '527640(01/22)',
  label: 'TD Cash Back Visa Card statement',
  must: Object.freeze([/TD\s+CASH\s+BACK\s+CARD/, /CALCULATING\s+YOUR\s+BALANCE/i, /STATEMENT\s+PERIOD:/]),
  mustNot: Object.freeze([]),
});

const TX = /^([A-Z]{3} \d{1,2}) ([A-Z]{3} \d{1,2}) (.+?) ((?:-|−)?\$\d[\d,]*\.\d{2}(?: CR)?)(?: .*)?$/;
const CARD = /\d{4} [\dX]{4} [\dX]{4} \d{4}/;

function classify(t) {
  if (/^STATEMENT PERIOD:/.test(t)) return 'Statement header; the Cash Back Dollars figure beside it is a rewards summary, not a transaction';
  if (/PREVIOUS STATEMENT BALANCE/.test(t)) return 'Opening balance (previous statement balance), carried as the section opening';
  if (/TOTAL NEW BALANCE/.test(t)) return 'Closing balance (total new balance), carried as the section closing';
  if (/^\$[\d,.]+ \$[\d,.]+ [A-Z][a-z]{2}\.? \d{1,2}, \d{4}/.test(t)) return 'Payment slip (new balance, minimum payment, due date), not a transaction';
  if (/^(Previous Balance|Payments & Credits|Purchases & Other Charges|Cash Advances|Interest|Fees|Sub-total|NEW BALANCE|Earned this statement period|Bonus, Accelerators|Total Cash Back Dollars)\b/.test(t)) return 'Balance calculation / cash back summary block, not a transaction';
  return null;
}

export function parse(pages) {
  const layout = ID;

  const periodRow = required(findRow(pages, /STATEMENT PERIOD:\s*(.+?) to (.+?)(?: Total Cash Back.*)?$/), layout, 'the statement period');
  const period = { start: parseLongDate(periodRow.match[1]), end: parseLongDate(periodRow.match[2]) };
  if (!period.start || !period.end) throw new ParseError(`${layout}: statement period "${periodRow.row}" is not two dates`);

  const acctRow = required(findRow(pages, new RegExp(`Account Number:\\s*(${CARD.source})`)), layout, 'the account number');
  const accountNumber = acctRow.match[1];

  const holderRow = required(findRow(pages, new RegExp(`^(.+?) (${CARD.source})$`)), layout, 'the cardholder line');
  const holderMatch = HOLDER_LINE.exec(holderRow.match[1]);
  if (!holderMatch) throw new ParseError(`${layout}: cardholder line "${holderRow.match[1]}" is not a name`);
  const holders = [holderMatch[1]];

  const openingRow = required(findRow(pages, /PREVIOUS STATEMENT BALANCE ((?:-|−)?\$[\d,]+\.\d{2}(?: CR)?)/), layout, 'the previous statement balance');
  const closingRow = required(findRow(pages, /TOTAL NEW BALANCE ((?:-|−)?\$[\d,]+\.\d{2}(?: CR)?)/), layout, 'the total new balance');
  const opening = parseMoney(openingRow.match[1]);
  const closing = parseMoney(closingRow.match[1]);
  if (opening === null || closing === null) throw new ParseError(`${layout}: previous/new balance is not a figure`);

  const consumed = new Set();
  const items = [];
  let sequence = 0;
  for (const r of walk(pages)) {
    const m = TX.exec(collapse(r.row));
    if (!m) continue;
    const amount = parseMoney(m[4]);
    if (amount === null) throw new ParseError(`${layout}: page ${r.page} row ${r.index}: amount unreadable: "${r.row}"`, r);
    consumed.add(rowKey(r.page, r.index));
    items.push(lineItem({
      date: monthDayToIso(m[1], period),
      effectiveDate: monthDayToIso(m[2], period),
      description: m[3],
      amount,
      page: r.page,
      sequence: sequence++,
      category: /^PAYMENT\b/.test(m[3]) ? 'Payment' : /INTEREST/.test(m[3]) ? 'Interest' : null,
    }));
  }

  const ignored = ignoredRows(pages, { consumed, classify, layout });

  return finish({
    layout, issuer: 'TD', documentType: 'credit-card', period,
    sections: [{
      identity: { accountNumber, holders, label: 'TD CASH BACK CARD' },
      period: { ...period },
      opening: { balance: round2(opening), printed: true },
      closing: { balance: round2(closing), printed: true },
      items,
      positions: null,
    }],
    ignored,
  });
}
