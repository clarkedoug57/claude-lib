/**
 * statement-parsers — the fixture suite.
 *
 * Every staged fixture that names a parser (provenance.parser) is the
 * specification for it: detection over the fixture's raw rows must match
 * exactly that id, the parser must reproduce the fixture's Statement byte for
 * byte from those rows, and every OTHER parser must refuse them. Then the
 * rules no corpus month exercises are proven on synthetic rows: the credit
 * forms on the Simplii card, the refusal on an unplaceable dated row, the
 * running-balance disagreement, and the year rule across New Year.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARSERS, PARSER_IDS, createParserRegistry, parseDocument, ParseError } from '../src/index.js';
import { yearFor, monthDayToIso, parseMoney, parseLongDate } from '../src/common.js';
import { detect, DETECT_OUTCOME } from '../../statement-detect/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

const specs = walk(FIXTURES)
  .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), fixture: JSON.parse(fs.readFileSync(f, 'utf8')) }))
  .filter(({ fixture }) => fixture.kind === 'statement' && fixture.provenance?.parser);

test('every registered parser has exactly one staged fixture naming it (the suite is never vacuous)', () => {
  const byParser = new Map(PARSER_IDS.map((id) => [id, specs.filter((s) => s.fixture.provenance.parser === id).map((s) => s.file)]));
  for (const [id, files] of byParser) assert.equal(files.length, 1, `${id}: ${files.length} fixture(s) — ${files.join(', ')}`);
});

for (const { file, fixture } of specs) {
  const id = fixture.provenance.parser;
  describe(`${file} ← ${id}`, () => {
    const text = fixture.raw.pages.map((rows) => rows.join('\n')).join('\n');

    test('detection over the raw rows matches exactly this parser', () => {
      const d = detect(text, createParserRegistry(), { pageCount: fixture.raw.pages.length });
      assert.equal(d.outcome, DETECT_OUTCOME.MATCH, JSON.stringify(d.matches));
      assert.equal(d.id, id);
      assert.deepEqual(d.matches, [id]);
    });

    test('the parser reproduces the fixture Statement from its raw rows, byte for byte', () => {
      const statement = PARSERS[id].parse(fixture.raw.pages);
      assert.deepEqual(statement, fixture.statement);
    });

    test('parseDocument routes to the same result', () => {
      const r = parseDocument(fixture.raw.pages);
      assert.equal(r.detection.id, id);
      assert.deepEqual(r.statement, fixture.statement);
    });

    test('every other parser refuses these rows', () => {
      for (const other of PARSER_IDS) {
        if (other === id) continue;
        assert.throws(() => PARSERS[other].parse(fixture.raw.pages), ParseError, `${other} accepted ${file}`);
      }
    });
  });
}

describe('the refusal rule', () => {
  test('a dated amount row the layout cannot place is a ParseError naming page and row', () => {
    const spec = specs.find((s) => s.fixture.provenance.parser === 'simplii-chequing');
    const pages = JSON.parse(JSON.stringify(spec.fixture.raw.pages));
    pages[0].push('Aug 09  NEW KIND OF ROW  12.34');
    assert.throws(() => PARSERS['simplii-chequing'].parse(pages), (e) => e instanceof ParseError && /page 1 row \d+ carries a date and an amount/.test(e.message));
  });

  test('a printed amount that disagrees with the running-balance delta is refused', () => {
    const spec = specs.find((s) => s.fixture.provenance.parser === 'simplii-chequing');
    const pages = JSON.parse(JSON.stringify(spec.fixture.raw.pages));
    const i = pages[0].findIndex((r) => /^Jul 31  Jul 30  WIGHTMAN/.test(r));
    pages[0][i] = pages[0][i].replace('101.58', '110.58');
    assert.throws(() => PARSERS['simplii-chequing'].parse(pages), /disagrees with the running-balance delta/);
  });

  test('a section that does not reconcile is refused (the gate runs inside parse)', () => {
    const spec = specs.find((s) => s.fixture.provenance.parser === 'td-line-of-credit');
    const pages = JSON.parse(JSON.stringify(spec.fixture.raw.pages));
    const p = pages.findIndex((rows) => rows.some((r) => /CLOSING BALANCE/.test(r)));
    const i = pages[p].findIndex((r) => /CLOSING BALANCE/.test(r));
    pages[p][i] = pages[p][i].replace(/-?[\d,]+\.\d{2}$/, '999.99');
    assert.throws(() => PARSERS['td-line-of-credit'].parse(pages), /does not reconcile/);
  });

  test('text no fingerprint recognises parses nothing', () => {
    const r = parseDocument([['Some Card Company', 'Your account at a glance', 'nothing here'.repeat(20)]]);
    assert.equal(r.detection.outcome, DETECT_OUTCOME.UNKNOWN);
    assert.equal(r.statement, null);
  });
});

describe('the Simplii card credit forms (no corpus month carries a payment — synthetic proof)', () => {
  function pages(rows) {
    return [[
      'TM  HOLDER-1', 'Simplii Financial', 'Account number', '4525 XXXX XXXX 0916', 'Cash Back Visa  Card',
      'August statement period', 'July 23 to August 22, 2026', 'Your account at a glance  Contact us',
      'Previous balance  $50.00', 'New balance  =  $1.30',
    ], [
      'Transactions  from July 23 to August 22, 2026',
      'Trans  Post', 'date  date  Description  Spend Categories  Amount($)',
      ...rows,
      'Page  2  of 3',
    ]];
  }
  test('a trailing CR, a trailing minus and a leading minus are each a credit; the section still balances', () => {
    for (const payment of ['50.00 CR', '50.00-', '-50.00']) {
      const s = PARSERS['simplii-credit-card'].parse(pages([
        `Jul 25  Jul 25  PAYMENT THANK YOU  Other Transactions  ${payment}`,
        'Aug 14  Aug 17  ELORA HOME HARDWARE  ELORA  ON  Home and Office Improvement  1.30',
      ]));
      assert.deepEqual(s.sections[0].items.map((i) => [i.description, i.amount, i.category]), [
        ['PAYMENT THANK YOU', -50, 'Other Transactions'],
        ['ELORA HOME HARDWARE  ELORA  ON', 1.3, 'Home and Office Improvement'],
      ]);
      assert.equal(s.sections[0].opening.balance, 50);
      assert.equal(s.sections[0].closing.balance, 1.3);
    }
  });
});

describe('common rules', () => {
  test('money forms', () => {
    assert.equal(parseMoney('1,234.56'), 1234.56);
    assert.equal(parseMoney('-$1,234.56'), -1234.56);
    assert.equal(parseMoney('−$3,045.89'), -3045.89);
    assert.equal(parseMoney('16,485.19-'), -16485.19);
    assert.equal(parseMoney('$1.49 CR'), -1.49);
    assert.equal(parseMoney('$1.49CR'), -1.49);
    assert.equal(parseMoney('4.450'), null);
    assert.equal(parseMoney('WIGHTMAN'), null);
  });

  test('long dates, including the abbreviated and kerning-split forms', () => {
    assert.equal(parseLongDate('July 30, 2026'), '2026-07-30');
    assert.equal(parseLongDate('Sept. 8, 2026'), '2026-09-08');
    assert.equal(parseLongDate('January 09, 2026'), '2026-01-09');
    assert.equal(parseLongDate('M arch 31, 2026'), '2026-03-31');
    assert.equal(parseLongDate('nonsense'), null);
  });

  test('the year rule across New Year: December rows take the start year, January rows the end year', () => {
    const period = { start: '2025-12-30', end: '2026-01-28' };
    assert.equal(yearFor(12, 31, period), 2025);
    assert.equal(yearFor(1, 5, period), 2026);
    assert.equal(monthDayToIso('Dec 31', period), '2025-12-31');
    assert.equal(monthDayToIso('Jan 05', period), '2026-01-05');
    // An effective date a day past the period end stays in the end year.
    assert.equal(monthDayToIso('Jan 29', period), '2026-01-29');
    // A single-year period never moves.
    assert.equal(yearFor(8, 31, { start: '2026-08-01', end: '2026-08-31' }), 2026);
  });
});
