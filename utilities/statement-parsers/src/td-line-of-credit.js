/**
 * td-line-of-credit.js — TD line of credit monthly statement (revolving portion).
 *
 *   ACTIVITY
 *   Date  Description  Amount ($)
 *   Jan 01  OPENING BALANCE  203.10
 *   Jan 02  JQ203 TFR-FR06X174A  -4,300.00
 *   Jan 05  TD VISA  X5A4Z3  5.48
 *   Jan 31  CLOSING BALANCE  2,516.50
 *
 * Balance owed is positive; an advance is + and a payment is − as printed. A
 * credit balance closes negative ("-3,045.89"). The extractor splits some
 * header words at their kerning ("St at ement", "M arch"); the header
 * patterns tolerate that, and descriptions are never rewritten.
 */

import {
  ParseError, cells, collapse, parseMoney, parseLongDate, monthDayToIso, walk, findRow,
  rowKey, ignoredRows, finish, lineItem, HOLDER_LINE, required, round2,
} from './common.js';

export const ID = 'td-line-of-credit';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: 'text-layer 2026',
  label: 'TD line of credit statement',
  must: Object.freeze([/REVOLVING PORTION ACCOUNT NUM\s?BER/i, /OPENING BALANCE/, /CLOSING BALANCE/]),
  mustNot: Object.freeze([]),
});

const DATE_CELL = /^[A-Z][a-z]{2} \d{2}$/;

/** Re-join the kerning splits the TD extractor produces in header lines only. */
const mend = (s) => collapse(s)
  .replace(/St\s*at\s*ement/gi, 'Statement')
  .replace(/\bt\s+o\b/g, 'to')
  .replace(/\bM\s+(arch|ay)\b/g, 'M$1');

function classify(t) {
  if (/OPENING BALANCE/.test(t)) return 'Opening balance row, carried as the section opening';
  if (/CLOSING BALANCE/.test(t)) return 'Closing balance row, carried as the section closing';
  if (/^[A-Z][a-z]{2} \d{2}\/\d{2} /.test(t)) return 'Payment details block (due date / overdue / minimum payment), not a transaction';
  if (/^\S+ [A-Z][a-z]{2} \d{2}\/\d{2} /.test(t)) return 'Payment slip, not a transaction';
  if (/^[A-Z][a-z]{2} \d{2} - [A-Z][a-z]{2} \d{2} /.test(t)) return 'Interest rate table row; the interest charge is already an item';
  if (/Tot\s?al Interest/i.test(t)) return 'Interest table total, not a transaction';
  if (/Credit Limit|Available Credit/i.test(t)) return 'Account summary: credit limit / available credit';
  if (/Non-?Int\s?erest Charges|Total New Advances|Total Payment/i.test(t) || /^\$[\d,]+\.\d{2}$/.test(t)) return 'Period totals summary block, not a transaction';
  if (/interest paid/i.test(t)) return 'Annual interest-paid notice, not a transaction';
  return null;
}

export function parse(pages) {
  const layout = ID;

  const periodRow = required(findRow(pages, /St\s*at\s*ement Period:\s*(.+)$/i), layout, 'the statement period');
  const pm = /^Statement Period:\s*(.+?)\s+to\s+(.+)$/i.exec(mend(periodRow.row));
  const period = pm ? { start: parseLongDate(pm[1]), end: parseLongDate(pm[2]) } : null;
  if (!period || !period.start || !period.end) throw new ParseError(`${layout}: statement period "${periodRow.row}" is not two dates`);

  const numLabel = findRow(pages, /ACCOUNT NUM\s?BER:$/i);
  let accountNumber = null;
  if (numLabel) {
    const next = pages[numLabel.page - 1][numLabel.index + 1];
    if (next) accountNumber = collapse(next);
  }
  if (!accountNumber) {
    const alt = required(findRow(pages, /^Account Number:\s*(\S+)$/i), layout, 'the account number');
    accountNumber = alt.match[1];
  }

  const borrowers = required(findRow(pages, /^Borrow\s?ers:$/i), layout, 'the borrowers line');
  const holders = [];
  const firstRows = pages[borrowers.page - 1];
  for (let i = borrowers.index + 1; i < firstRows.length; i++) {
    const m = HOLDER_LINE.exec(collapse(firstRows[i]));
    if (!m) break;
    holders.push(m[1]);
  }
  if (holders.length === 0) throw new ParseError(`${layout}: no borrower name after "Borrowers:"`);

  const consumed = new Set();
  const items = [];
  let opening = null;
  let closing = null;
  let sequence = 0;

  for (const r of walk(pages)) {
    const parts = cells(r.row);
    if (parts.length < 3) continue;
    // "M ar 01  OPENING BALANCE" — the kerning split reaches the date cell on
    // the anchor rows. Mend the month only; a description is never rewritten.
    parts[0] = parts[0].replace(/^([A-Z])\s+([a-z]{2}) (\d{2})$/, '$1$2 $3');
    if (!DATE_CELL.test(parts[0])) continue;
    const amount = parseMoney(parts[parts.length - 1]);
    if (amount === null) continue; // a dated row without a trailing figure is not an activity row; ignoredRows decides its fate
    const description = parts.slice(1, -1).join('  ');
    if (/^OPENING BALANCE$/i.test(description)) {
      if (opening !== null) throw new ParseError(`${layout}: a second OPENING BALANCE on page ${r.page}`, r);
      opening = amount;
      consumed.add(rowKey(r.page, r.index));
      continue;
    }
    if (/^CLOSING BALANCE$/i.test(description)) {
      if (closing !== null) throw new ParseError(`${layout}: a second CLOSING BALANCE on page ${r.page}`, r);
      closing = amount;
      consumed.add(rowKey(r.page, r.index));
      continue;
    }
    if (opening === null) throw new ParseError(`${layout}: an activity row precedes OPENING BALANCE: "${r.row}"`, r);
    if (closing !== null) throw new ParseError(`${layout}: an activity row follows CLOSING BALANCE: "${r.row}"`, r);
    consumed.add(rowKey(r.page, r.index));
    items.push(lineItem({
      date: monthDayToIso(parts[0], period),
      description,
      amount,
      page: r.page,
      sequence: sequence++,
      category: /^INTEREST$/i.test(description) ? 'Interest' : null,
    }));
  }
  if (opening === null) throw new ParseError(`${layout}: OPENING BALANCE not found`);
  if (closing === null) throw new ParseError(`${layout}: CLOSING BALANCE not found`);

  const ignored = ignoredRows(pages, { consumed, classify, layout });

  return finish({
    layout, issuer: 'TD', documentType: 'line-of-credit', period,
    sections: [{
      identity: { accountNumber, holders, label: 'REVOLVING PORTION' },
      period: { ...period },
      opening: { balance: round2(opening), printed: true },
      closing: { balance: round2(closing), printed: true },
      items,
      positions: null,
    }],
    ignored,
  });
}
