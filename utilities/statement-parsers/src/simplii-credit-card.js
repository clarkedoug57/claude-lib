/**
 * simplii-credit-card.js — Simplii Financial Cash Back Visa Card statement.
 *
 *   Trans  Post
 *   date  date  Description  Spend Categories  Amount($)
 *   Aug 14  Aug 17  ELORA HOME HARDWARE  ELORA  ON  Home and Office Improvement  2.79
 *
 * Balance owed is positive; a credit balance prints as "$1.49 CR". A purchase
 * is + as printed. The issuer's spend category (Title Case, the cell before
 * the amount) is carried as the item category — the one layout of the six
 * where the issuer prints its own categorisation.
 *
 * UNTESTED IN THE CORPUS (stated, R-593): no month in the statements folder
 * carries a payment or a merchant credit on this card. A leading minus or a
 * trailing "CR" / "-" on the amount is read as a credit; that branch is proven
 * only by the synthetic unit case in the test file.
 */

import {
  ParseError, cells, collapse, parseMoney, parseLongDate, monthDayToIso, monthIndex, isoDate, walk, findRow,
  rowKey, ignoredRows, finish, lineItem, HOLDER_LINE, required, round2,
} from './common.js';

export const ID = 'simplii-credit-card';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: '2026',
  label: 'Simplii Financial Cash Back Visa Card statement',
  must: Object.freeze([/Simplii Financial/, /Cash Back Visa\s+Card/i, 'Your account at a glance']),
  mustNot: Object.freeze(['7010CA-', '7010PLC']),
});

const TX_ROW = /^([A-Z][a-z]{2} \d{2})\s{2,}([A-Z][a-z]{2} \d{2})\s{2,}(.+)$/;
const TITLE_CASE = /^[A-Z][a-z]+(?: (?:and|of|[A-Z][a-z]+))*$/;

function classify(t) {
  if (/^Total for\b/i.test(t)) return 'Section total, not a transaction';
  if (/^Previous balance\b/i.test(t)) return 'Account-at-a-glance summary: previous balance, carried as the section opening';
  if (/^New balance\s+=/i.test(t)) return 'Account-at-a-glance summary: new balance, carried as the section closing';
  if (/^(Payments|Other credits|Total credits|Purchases|Cash advances|Interest|Fees|Total charges|Current month.s minimum payment|As at last statement|[\d.]+% Cash Back|Total Cash Back|Regular purchases)\b/i.test(t)) return 'Account-at-a-glance summary block (totals, rewards, rates), not a transaction';
  if (/^[A-Z][a-z]{2} \d{1,2}, \d{4}\s+\$/.test(t) || /New balance\s+\$/i.test(t)) return 'Payment slip (due date, minimum payment, new balance), not a transaction';
  if (/Spend Report|Spend Categories|Total Monthly Budget|^Total\s+\d|^(Other Transactions|Home and Office|Retail and Grocery|Transportation|Restaurants|Hotel|Health|Professional|Personal|Foreign Currency)\b/i.test(t)) return 'Spend report row (category totals), not a transaction';
  return null;
}

export function parse(pages) {
  const layout = ID;
  const first = (pages && pages[0]) || [];

  // "July 23 to August 22, 2026" — the start year is the end year unless the
  // period crosses New Year.
  const periodRow = required(findRow(pages, /^([A-Z][a-z]+ \d{1,2}) to ([A-Z][a-z]+ \d{1,2}, \d{4})$/), layout, 'the statement period');
  const end = parseLongDate(periodRow.match[2]);
  const sm = /^([A-Z][a-z]+) (\d{1,2})$/.exec(periodRow.match[1]);
  const startMonth = sm ? monthIndex(sm[1]) : null;
  if (!end || !startMonth) throw new ParseError(`${layout}: statement period "${periodRow.row}" is not two dates`);
  const endYear = Number(end.slice(0, 4));
  const startYear = startMonth > Number(end.slice(5, 7)) ? endYear - 1 : endYear;
  const period = { start: isoDate(startYear, startMonth, sm[2]), end };

  const acctRow = required(first.map(collapse).find((r) => /^\d{4} XXXX XXXX \d{4}$/.test(r)), layout, 'the card number');
  const accountNumber = acctRow;

  const holderRow = required(first.map(collapse).map((r) => /^TM\s+(.+)$/.exec(r)).find(Boolean), layout, 'the cardholder line');
  const holderMatch = HOLDER_LINE.exec(holderRow[1]);
  if (!holderMatch) throw new ParseError(`${layout}: cardholder line "${holderRow[1]}" is not a name`);
  const holders = [holderMatch[1]];

  const openingRow = required(findRow(pages, /^Previous balance\s+(.+)$/i), layout, 'the previous balance');
  const opening = parseMoney(openingRow.match[1]);
  const closingRow = required(findRow(pages, /^New balance\s+=\s+(.+)$/i), layout, 'the new balance');
  const closing = parseMoney(closingRow.match[1]);
  if (opening === null || closing === null) throw new ParseError(`${layout}: previous/new balance is not a figure`, { openingRow: openingRow.row, closingRow: closingRow.row });

  const consumed = new Set();
  const items = [];
  let sequence = 0;
  for (const r of walk(pages)) {
    const m = TX_ROW.exec(r.row.trim());
    if (!m) continue;
    const rest = cells(m[3]);
    const amount = rest.length > 0 ? parseMoney(rest[rest.length - 1]) : null;
    if (amount === null) throw new ParseError(`${layout}: page ${r.page} row ${r.index} is a transaction row without an amount: "${r.row}"`, r);
    let descriptionCells = rest.slice(0, -1);
    let category = null;
    if (descriptionCells.length > 1 && TITLE_CASE.test(descriptionCells[descriptionCells.length - 1])) {
      category = descriptionCells[descriptionCells.length - 1];
      descriptionCells = descriptionCells.slice(0, -1);
    }
    const description = descriptionCells.join('  ');
    if (description.length === 0) throw new ParseError(`${layout}: page ${r.page} row ${r.index} has no description: "${r.row}"`, r);
    consumed.add(rowKey(r.page, r.index));
    items.push(lineItem({
      date: monthDayToIso(m[1], period),
      effectiveDate: monthDayToIso(m[2], period),
      description,
      amount,
      page: r.page,
      sequence: sequence++,
      category,
    }));
  }

  const ignored = ignoredRows(pages, { consumed, classify, layout });

  return finish({
    layout, issuer: 'Simplii Financial', documentType: 'credit-card', period,
    sections: [{
      identity: { accountNumber, holders, label: 'Cash Back Visa Card' },
      period: { ...period },
      opening: { balance: round2(opening), printed: true },
      closing: { balance: round2(closing), printed: true },
      items,
      positions: null,
    }],
    ignored,
  });
}
