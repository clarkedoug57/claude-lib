/**
 * simplii-ledger.js — the ONE reader for Simplii's deposit-style ledgers.
 *
 * The no-fee chequing account (form 7010CA) and the personal line of credit
 * (form 7010PLC) print the identical table:
 *
 *   trans.  eff.  transaction  funds out  funds in  balance
 *   Jul 31  Jul 30  WIGHTMAN  101.58  1,864.26
 *   Aug 03  Aug 03  INTERAC E-TRANSFER RECEIVE J DOE  1,700.00  3,434.23
 *
 * THE SIGN RULE
 *   The extractor cannot tell the funds-out column from the funds-in column —
 *   both are "a number before the balance". The running balance can: the sign
 *   of an item is the sign of (balance − previous balance), and the printed
 *   magnitude must equal that delta to the cent or the row is refused. The
 *   first delta is taken from BALANCE FORWARD. A line of credit prints its
 *   balances with a trailing minus ("16,485.19-"): the balance owed is a
 *   negative deposit balance, and the same rule holds.
 *
 * Both layouts return a section whose closing is the printed "closing balance"
 * line, cross-checked against the last running balance.
 */

import {
  ParseError, cells, collapse, parseMoney, parseLongDate, monthDayToIso, walk, findRow, rowKey,
  ignoredRows, finish, lineItem, HOLDER_LINE, required, round2,
} from './common.js';

const TX_ROW = /^([A-Z][a-z]{2} \d{2})\s{2,}([A-Z][a-z]{2} \d{2})\s{2,}(.+)$/;

function classify(t) {
  if (/BALANCE FORWARD/i.test(t)) return 'Opening balance row (balance forward), not a transaction';
  if (/^closing balance\b/i.test(t)) return 'Closing balance summary line, carried as the section closing';
  if (/^total funds (out|in)\b/i.test(t)) return 'Period total, not a transaction';
  if (/overdraft (limit|amount due)/i.test(t)) return 'Overdraft limit / amount due, not a transaction';
  if (/minimum payment due|payment summary|past due|current due|overlimit due|credit limit|credit available/i.test(t)) return 'Payment summary block (limits, dues, due date), not a transaction';
  if (/interest charge summary|per annum|total interest charge/i.test(t)) return 'Interest charge summary / rate row; the interest is already posted as an item';
  if (/^\d+\.\d{2}%\s/.test(t)) return 'Illustrative interest-rate table, not account activity';
  return null;
}

/**
 * @param {string[][]} pages
 * @param {{ layout: string, issuer: string, documentType: string, labelPattern: RegExp }} spec
 */
export function parseSimpliiLedger(pages, { layout, issuer, documentType, labelPattern }) {
  const first = (pages && pages[0]) || [];
  const labelRow = required(first.map(collapse).find((r) => labelPattern.test(r)), layout, 'the account label row');
  const label = labelRow.replace(/\s*\(cont'd\)$/i, '');

  const periodRow = required(findRow(pages, /^statement period:\s*(.+?)\s*-\s*(.+)$/i), layout, 'the statement period');
  const period = { start: parseLongDate(periodRow.match[1]), end: parseLongDate(periodRow.match[2]) };
  if (!period.start || !period.end) throw new ParseError(`${layout}: statement period "${periodRow.row}" is not two dates`);

  const acctRow = required(findRow(pages, /^account number:\s*(\S+)$/i), layout, 'the account number');
  const accountNumber = acctRow.match[1];

  // Holders: the lines immediately after the account number on page 1, until
  // a line that is not a name (the address starts with a digit; a redacted
  // address is REDACTED, which HOLDER_LINE refuses).
  const holders = [];
  for (let i = acctRow.index + 1; i < first.length; i++) {
    const m = HOLDER_LINE.exec(first[i].trim());
    if (!m) break;
    holders.push(m[1]);
  }

  const consumed = new Set();
  const items = [];
  let opening = null;
  let previous = null;
  let sequence = 0;

  for (const r of walk(pages)) {
    const m = TX_ROW.exec(r.row.trim());
    if (!m) continue;
    const rest = cells(m[3]);
    const balance = rest.length > 0 ? parseMoney(rest[rest.length - 1]) : null;
    if (balance === null) throw new ParseError(`${layout}: page ${r.page} row ${r.index} is a transaction row without a running balance: "${r.row}"`, r);
    const beforeBalance = rest.slice(0, -1);
    const amount = beforeBalance.length > 0 ? parseMoney(beforeBalance[beforeBalance.length - 1]) : null;
    const descriptionCells = amount === null ? beforeBalance : beforeBalance.slice(0, -1);
    const description = descriptionCells.join('  ');
    consumed.add(rowKey(r.page, r.index));

    if (/^BALANCE FORWARD$/i.test(description)) {
      if (opening !== null) throw new ParseError(`${layout}: a second BALANCE FORWARD on page ${r.page}`, r);
      if (amount !== null) throw new ParseError(`${layout}: BALANCE FORWARD carries an amount: "${r.row}"`, r);
      opening = balance;
      previous = balance;
      continue;
    }
    if (opening === null) throw new ParseError(`${layout}: a transaction row precedes BALANCE FORWARD: "${r.row}"`, r);
    if (amount === null) throw new ParseError(`${layout}: page ${r.page} row ${r.index} has a balance but no amount: "${r.row}"`, r);
    if (description.length === 0) throw new ParseError(`${layout}: page ${r.page} row ${r.index} has no description: "${r.row}"`, r);

    const delta = round2(balance - previous);
    if (Math.abs(Math.abs(delta) - Math.abs(amount)) > 0.005) {
      throw new ParseError(`${layout}: page ${r.page} row ${r.index}: printed amount ${amount} disagrees with the running-balance delta ${delta}: "${r.row}"`, { ...r, amount, delta });
    }
    items.push(lineItem({
      date: monthDayToIso(m[1], period),
      effectiveDate: monthDayToIso(m[2], period),
      description,
      amount: delta,
      runningBalance: balance,
      page: r.page,
      sequence: sequence++,
      category: /^INTEREST( CHARGE)?$/i.test(description) ? 'interest' : null,
    }));
    previous = balance;
  }
  if (opening === null) throw new ParseError(`${layout}: BALANCE FORWARD not found`);

  const closingRow = required(findRow(pages, /^closing balance\s+(\S+)$/i), layout, 'the closing balance line');
  const closing = parseMoney(closingRow.match[1]);
  if (closing === null) throw new ParseError(`${layout}: closing balance "${closingRow.row}" is not a figure`);
  if (Math.abs(closing - previous) > 0.005) {
    throw new ParseError(`${layout}: printed closing balance ${closing} ≠ last running balance ${previous}`, { closing, previous });
  }

  const ignored = ignoredRows(pages, { consumed, classify, layout });

  return finish({
    layout, issuer, documentType, period,
    sections: [{
      identity: { accountNumber, holders, label },
      period: { ...period },
      opening: { balance: round2(opening), printed: true },
      closing: { balance: round2(closing), printed: true },
      items,
      positions: null,
    }],
    ignored,
  });
}
