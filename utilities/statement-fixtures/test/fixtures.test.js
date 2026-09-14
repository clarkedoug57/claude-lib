/**
 * statement-fixtures — the fixture suite.
 *
 * Redaction is proven on synthetic rows shaped like real ones: an account
 * number, a card number, a joint holder pair, an Interac counterparty, a
 * merchant string that must SURVIVE, and amounts that must be byte-identical.
 * Then staging is proven to refuse a leak, and the negative fixture to keep
 * the verdict's reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageFixture, stageVerdictFixture, redactStatement, redactText, findResiduals, fixtureId, FIXTURE_KIND,
} from '../src/index.js';

function statement() {
  return {
    issuer: 'Example Bank',
    documentType: 'chequing',
    currency: 'CAD',
    period: { start: '2026-07-30', end: '2026-08-30' },
    sections: [{
      identity: { accountNumber: '01-23456', holders: ['JANE Q EXAMPLE', 'JOHN EXAMPLE'], label: 'no fee chequing' },
      period: null,
      opening: { balance: 1965.84, printed: true },
      closing: { balance: 1558.48, printed: true },
      items: [
        { date: '2026-08-01', effectiveDate: null, description: 'INTERAC E-TRANSFER SEND Alex Neighbour', amount: -250.00, runningBalance: 1715.84, page: 1, sequence: 0, category: null },
        { date: '2026-08-02', effectiveDate: null, description: 'ELORA HOME HARD', amount: -157.36, runningBalance: 1558.48, page: 1, sequence: 1, category: null },
      ],
      positions: null,
    }],
    ignored: [{ page: 2, text: 'Questions? Call 1 888 723 8881', reason: 'contact footer' }],
  };
}

const RAW = [
  ['account number: 01-23456', 'JANE Q EXAMPLE and JOHN EXAMPLE', 'Aug 01  INTERAC E-TRANSFER SEND Alex Neighbour  250.00  1,715.84'],
  ['Aug 02  ELORA HOME HARD  157.36  1,558.48', 'Card number 4525 1234 5678 9012'],
];

describe('redactText', () => {
  test('masks an account number to its last four and keeps amounts', () => {
    const out = redactText('account number: 01-23456  balance 1,715.84');
    assert.equal(out, 'account number: ····3456  balance 1,715.84');
  });

  test('masks a card number but keeps its shape', () => {
    assert.equal(redactText('Card number 4525 1234 5678 9012'), 'Card number 4525 XXXX XXXX 9012');
    // Double-spaced groups (the TD extractor) and a partly masked number are
    // masked too, normalised to single spaces (R-593).
    assert.equal(redactText('Account  Number:  4520  34XX  XXXX  9734'), 'Account  Number:  4520 XXXX XXXX 9734');
    assert.equal(redactText('5181  1622  4301  3990'), '5181 XXXX XXXX 3990');
  });

  test('replaces holders and listed names, longest first', () => {
    const out = redactText('JANE Q EXAMPLE and JANE', { holders: ['JANE Q EXAMPLE'], names: ['Jane'] });
    assert.equal(out, 'HOLDER-1 and PERSON-1');
  });

  test('an Interac counterparty is replaced even when no name was listed', () => {
    assert.equal(redactText('INTERAC E-TRANSFER SEND Alex Neighbour'), 'INTERAC E-TRANSFER SEND PERSON-X');
    assert.equal(redactText('E-TRANSFER REQ MONEY Pat Cousin'), 'E-TRANSFER REQ MONEY PERSON-X');
  });

  test('an Interac counterparty on a RAW extractor row loses the name and KEEPS the figures (R-593)', () => {
    // The R-591 staging defect: the whole rest of the row became PERSON-X and
    // the amount + running balance went with it. Chequing, line-of-credit
    // (trailing minus) and a listed name each keep every figure byte-identical.
    assert.equal(redactText('Aug 11  Aug 11  INTERAC E-TRANSFER SEND Dawn Fish  152.00  1,817.13'),
      'Aug 11  Aug 11  INTERAC E-TRANSFER SEND PERSON-X  152.00  1,817.13');
    assert.equal(redactText('Aug 03  Aug 03  INTERAC E-TRANSFER SEND Keaton Brewster  65.00  16,550.19-'),
      'Aug 03  Aug 03  INTERAC E-TRANSFER SEND PERSON-X  65.00  16,550.19-');
    assert.equal(redactText('Aug 27  Aug 27  INTERAC E-TRANSFER REQ MONEY Jo-Ann Allward  4,000.00  6,616.27-', { names: ['Jo-Ann Allward'] }),
      'Aug 27  Aug 27  INTERAC E-TRANSFER REQ MONEY PERSON-1  4,000.00  6,616.27-');
    assert.equal(redactText('Aug 03  Aug 03  INTERAC E-TRANSFER RECEIVE JO-ANN ALLWARD  1,700.00  3,434.23', { holders: ['MS JO-ANN B ALLWARD'] }),
      'Aug 03  Aug 03  INTERAC E-TRANSFER RECEIVE PERSON-X  1,700.00  3,434.23');
    assert.deepEqual(findResiduals('INTERAC E-TRANSFER SEND PERSON-X  152.00  1,817.13'), []);
    assert.deepEqual(findResiduals('INTERAC E-TRANSFER SEND Dawn Fish  152.00  1,817.13'), ['E-TRANSFER SEND Dawn Fish  152.00  1,817.13']);
  });

  test('RECEIVE lines and E-TFR forms are people too; a bank reference after the verb is left alone', () => {
    // The R-591 corpus: two RECEIVE lines survived the first rule. Never again.
    assert.equal(redactText('INTERAC E-TRANSFER RECEIVE Pat Cousin'), 'INTERAC E-TRANSFER RECEIVE PERSON-X');
    assert.equal(redactText('SEND E-TFR * * * J5b'), 'SEND E-TFR * * * J5b');
  });

  test('a transfer reference naming the other account is masked to its last three characters', () => {
    assert.equal(redactText('HP355 TFR-FR 392HF3J  -16,966.16'), 'HP355 TFR-FR ····F3J  -16,966.16');
    assert.equal(redactText('RQ551 TFR-FR392HF3J'), 'RQ551 TFR-FR····F3J');
    // A reference already on the redact list stays REDACTED; a masked one is not re-masked.
    assert.equal(redactText('HP355 TFR-FR 392HF3J', { redact: ['392HF3J'] }), 'HP355 TFR-FR REDACTED');
    assert.equal(redactText('HP355 TFR-FR ····F3J'), 'HP355 TFR-FR ····F3J');
  });

  test('the redact list replaces arbitrary phrases, whitespace-insensitively', () => {
    const out = redactText('DOUGLAS  EXAMPLE\n38  MAIN  ST  E\nTOWN ON  N0B 1S0', { redact: ['Douglas Example', '38 Main St E', 'N0B 1S0'] });
    assert.equal(out, 'REDACTED\nREDACTED\nTOWN ON  REDACTED');
  });

  test('a merchant string survives', () => {
    assert.equal(redactText('ELORA HOME HARD  157.36'), 'ELORA HOME HARD  157.36');
  });

  test('a four-digit amount is not mistaken for an account number', () => {
    assert.equal(redactText('deposit 5250.01'), 'deposit 5250.01');
    assert.equal(redactText('deposit 19,307.71'), 'deposit 19,307.71');
  });

  test('adjacent numbers separated by spaces are never merged; a decimal amount is never touched', () => {
    // The R-591 corpus defect: "0194  250.00" → "····4250.00".
    assert.equal(redactText('Aug 04  TD ATM W/D  0194  250.00'), 'Aug 04  TD ATM W/D  0194  250.00');
    assert.equal(redactText('TRILLIUM MUTUAL INSURANCE CO  291.65  926.55'), 'TRILLIUM MUTUAL INSURANCE CO  291.65  926.55');
    assert.equal(redactText('Purchases  $0.00  21.99%  0.06024%'), 'Purchases  $0.00  21.99%  0.06024%');
    assert.equal(redactText('Aug 01 - Aug 31  4.450  +5.990  10.440  95.57'), 'Aug 01 - Aug 31  4.450  +5.990  10.440  95.57');
    // An ISO date in a raw row is a date, not an identifier.
    assert.equal(redactText('posted 2026-08-30  1,558.48'), 'posted 2026-08-30  1,558.48');
    assert.deepEqual(findResiduals('posted 2026-08-30'), []);
    // A genuine 5+ digit identifier beside an amount is still masked, the amount kept.
    assert.equal(redactText('TD ATM W/D  0019421  250.00'), 'TD ATM W/D  ····9421  250.00');
    assert.equal(redactText('account number:  0086191459'), 'account number:  ····1459');
  });
});

describe('redactStatement', () => {
  test('masks identity, replaces holders, keeps every amount and date byte-identical', () => {
    const r = redactStatement(statement(), { names: ['Alex Neighbour'] });
    assert.equal(r.sections[0].identity.accountNumber, '····3456');
    assert.deepEqual(r.sections[0].identity.holders, ['HOLDER-1', 'HOLDER-2']);
    assert.equal(r.sections[0].items[0].description, 'INTERAC E-TRANSFER SEND PERSON-1');
    assert.equal(r.sections[0].items[1].description, 'ELORA HOME HARD');
    assert.deepEqual(r.sections[0].items.map((i) => [i.date, i.amount, i.runningBalance]),
      [['2026-08-01', -250, 1715.84], ['2026-08-02', -157.36, 1558.48]]);
    assert.equal(r.sections[0].opening.balance, 1965.84);
    // A space-grouped toll-free number is not an identifier and is left alone
    // (masking it would need runs to cross spaces — the merged-amount defect).
    assert.equal(r.ignored[0].text, 'Questions? Call 1 888 723 8881');
  });

  test('does not mutate its input', () => {
    const s = statement();
    redactStatement(s);
    assert.equal(s.sections[0].identity.accountNumber, '01-23456');
  });
});

describe('stageFixture', () => {
  test('builds a redacted fixture with provenance and the raw rows', () => {
    const f = stageFixture({
      statement: statement(), rawPages: RAW, notes: 'first Example Bank chequing',
      provenance: { sourceHash: 'abc', hasTextLayer: true }, names: ['Alex Neighbour'], version: '2024-09',
    });
    assert.equal(f.kind, FIXTURE_KIND.STATEMENT);
    assert.equal(f.id, 'example-bank/chequing/2024-09');
    assert.equal(f.raw.pages[0][0], 'account number: ····3456');
    assert.equal(f.raw.pages[0][1], 'HOLDER-1 and HOLDER-2');
    assert.equal(f.raw.pages[0][2], 'Aug 01  INTERAC E-TRANSFER SEND PERSON-1  250.00  1,715.84');
    // The un-listed counterparty path keeps the figures too (R-593).
    const g = stageFixture({ statement: statement(), rawPages: RAW, provenance: { sourceHash: 'abc', hasTextLayer: true } });
    assert.equal(g.raw.pages[0][2], 'Aug 01  INTERAC E-TRANSFER SEND PERSON-X  250.00  1,715.84');
    assert.equal(g.statement.sections[0].items[0].description, 'INTERAC E-TRANSFER SEND PERSON-X');
    assert.equal(f.raw.pages[1][1], 'Card number 4525 XXXX XXXX 9012');
    assert.equal(f.provenance.pageCount, 2);
    assert.equal(f.provenance.hasTextLayer, true);
    assert.equal(f.provenance.sourceHash, 'abc');
  });

  test('REFUSES to stage when the human-written notes carry a name or a number', () => {
    // Redaction rewrites the statement and the raw rows; it never rewrites a
    // person's notes. So the notes are the one place a leak can survive, and
    // staging must refuse rather than publish it.
    assert.throws(
      () => stageFixture({ statement: statement(), rawPages: RAW, names: ['Alex Neighbour'], notes: 'sent to Alex Neighbour for the roof' }),
      /residuals[\s\S]*notes: Alex Neighbour/,
    );
    assert.throws(
      () => stageFixture({ statement: statement(), rawPages: RAW, notes: 'account 01-23456 is the joint one' }),
      /residuals[\s\S]*notes: 01-23456/,
    );
  });

  test('findResiduals reports an unmasked 5+ digit run, a surviving name, a bare transfer ref and a bare Interac counterparty', () => {
    assert.deepEqual(findResiduals('acct 123456 for JANE', { holders: ['JANE'] }), ['123456', 'JANE']);
    assert.deepEqual(findResiduals('acct ····3456 for HOLDER-1', { holders: ['JANE'] }), []);
    assert.deepEqual(findResiduals('HP355 TFR-FR 392HF3J'), ['TFR-FR 392HF3J']);
    assert.deepEqual(findResiduals('INTERAC E-TRANSFER RECEIVE Pat Cousin'), ['E-TRANSFER RECEIVE Pat Cousin']);
    assert.deepEqual(findResiduals('INTERAC E-TRANSFER RECEIVE PERSON-X'), []);
    assert.deepEqual(findResiduals('lives at 38  Main St', { redact: ['38 Main St'] }), ['38 Main St']);
  });

  test('re-redacting an already-staged fixture keeps its HOLDER placeholders', () => {
    const staged = stageFixture({ statement: statement(), rawPages: RAW, names: ['Alex Neighbour'] });
    const again = stageFixture({ statement: staged.statement, rawPages: staged.raw.pages, redact: ['38 Main St'] });
    assert.deepEqual(again.statement.sections[0].identity.holders, ['HOLDER-1', 'HOLDER-2']);
    assert.equal(again.raw.pages[0][1], 'HOLDER-1 and HOLDER-2');
  });

  test('refuses without a canonical statement', () => {
    assert.throws(() => stageFixture({ statement: null }), TypeError);
  });
});

describe('stageVerdictFixture — the negative fixture', () => {
  test('keeps the verdict and its reason, redacted', () => {
    const f = stageVerdictFixture({
      id: 'example-bank/web-capture',
      verdict: { kind: 'not-a-statement', reason: 'Last Statement Balance: Not applicable · No Transactions · account 987654321' },
      rawPages: [],
      provenance: { hasTextLayer: false, pageCount: 2 },
    });
    assert.equal(f.kind, FIXTURE_KIND.VERDICT);
    assert.equal(f.verdict.kind, 'not-a-statement');
    assert.equal(f.verdict.reason, 'Last Statement Balance: Not applicable · No Transactions · account ····4321');
    assert.equal(f.provenance.hasTextLayer, false);
  });

  test('refuses a verdict without a reason', () => {
    assert.throws(() => stageVerdictFixture({ id: 'x', verdict: { kind: 'unsupported' } }), TypeError);
  });
});

test('fixtureId slugs issuer, type and version', () => {
  assert.equal(fixtureId({ issuer: "President's Choice Financial", documentType: 'World Elite Mastercard' }), 'president-s-choice-financial/world-elite-mastercard');
  assert.equal(fixtureId({ issuer: 'Simplii Financial', documentType: 'personal line of credit', version: '2024/09' }), 'simplii-financial/personal-line-of-credit/2024-09');
});
