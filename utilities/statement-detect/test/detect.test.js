/**
 * statement-detect — the fixture suite.
 *
 * The four outcomes, each produced on purpose; the registry's refusals; and the
 * evidence shape the agent surfaces when a document is refused. The
 * fingerprints here are synthetic — a real one is registered by the app that
 * owns the parser it routes to.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detect, createRegistry, registerFingerprint, DETECT_OUTCOME, DEFAULT_MIN_CHARS, DEFAULT_MIN_CHARS_PER_PAGE } from '../src/index.js';

const INVESTMENT_TEXT = `
Example Direct Investing
Your RIF statement: August 31, 2026
Account number: 12A345B
Holdings in your account
on August 31, 2026
Cash 60.60
Activity in your account
`.repeat(3);

const CHEQUING_TEXT = `
Example Bank  your no fee chequing account
account number: 12-34567
statement period: July 30 to August 30, 2026
trans. date  eff. date  transaction  funds out  funds in  balance
form 7010CA-2024/09
`.repeat(3);

function registry() {
  const r = createRegistry();
  registerFingerprint(r, {
    id: 'example-direct-investing',
    version: '2026-07',
    must: [/Account\s+number:/i, /^\s*(holdings in your account\s*$|activity in your account)/im],
  });
  registerFingerprint(r, {
    id: 'example-chequing',
    version: '2024-09',
    must: ['your no fee chequing account', /form 7010CA/],
    mustNot: [/line of credit/i],
  });
  return r;
}

describe('the four outcomes', () => {
  test('exactly one fingerprint → match, with its id', () => {
    const r = detect(INVESTMENT_TEXT, registry());
    assert.equal(r.outcome, DETECT_OUTCOME.MATCH);
    assert.equal(r.id, 'example-direct-investing');
    assert.deepEqual(r.matches, ['example-direct-investing']);
  });

  test('a second layout routes to ITS id, not the first registered', () => {
    const r = detect(CHEQUING_TEXT, registry());
    assert.equal(r.outcome, DETECT_OUTCOME.MATCH);
    assert.equal(r.id, 'example-chequing');
  });

  test('no fingerprint → unknown, with the evidence naming what failed', () => {
    const r = detect('Some Card Company\nYour account at a glance\nCard number 4525 XXXX XXXX 1234\n'.repeat(3), registry());
    assert.equal(r.outcome, DETECT_OUTCOME.UNKNOWN);
    assert.equal(r.id, null);
    assert.equal(r.evidence.length, 2);
    const inv = r.evidence.find((e) => e.id === 'example-direct-investing');
    assert.equal(inv.matched, false);
    assert.ok(inv.must.some((m) => m.hit === false), 'evidence must say which must-pattern missed');
  });

  test('two fingerprints → ambiguous, never a guess', () => {
    const r = registry();
    registerFingerprint(r, { id: 'overlapping', must: [/Account\s+number:/i] });
    const d = detect(INVESTMENT_TEXT, r);
    assert.equal(d.outcome, DETECT_OUTCOME.AMBIGUOUS);
    assert.equal(d.id, null);
    assert.deepEqual(d.matches.sort(), ['example-direct-investing', 'overlapping']);
  });

  test('a mustNot pattern excludes a near-identical sibling layout', () => {
    const r = registry();
    const loc = detect(CHEQUING_TEXT.replace(/your no fee chequing account/g, 'your no fee chequing account / personal line of credit'), r);
    assert.equal(loc.outcome, DETECT_OUTCOME.UNKNOWN, 'the line-of-credit mustNot must exclude the chequing fingerprint');
  });
});

describe('the no-text signal', () => {
  test('below the minimum characters → no-text, before any fingerprint runs', () => {
    const r = detect('', registry());
    assert.equal(r.outcome, DETECT_OUTCOME.NO_TEXT);
    assert.equal(r.chars, 0);
    assert.deepEqual(r.evidence, []);
  });

  test('whitespace does not count as text', () => {
    const r = detect(' \n\t '.repeat(100), registry());
    assert.equal(r.outcome, DETECT_OUTCOME.NO_TEXT);
  });

  test('the threshold is the default 50 and can be overridden', () => {
    assert.equal(DEFAULT_MIN_CHARS, 50);
    const short = 'x'.repeat(49);
    assert.equal(detect(short, registry()).outcome, DETECT_OUTCOME.NO_TEXT);
    assert.equal(detect(short, registry(), { minChars: 10 }).outcome, DETECT_OUTCOME.UNKNOWN);
  });

  test('with a page count the floor scales: 60 stray characters on a 5-page scan is no-text', () => {
    assert.equal(DEFAULT_MIN_CHARS_PER_PAGE, 100);
    const stray = 'WORLD ELITE MASTERCARD STATEMENT ' + 'x'.repeat(30); // ~60 non-space chars
    assert.equal(detect(stray, registry()).outcome, DETECT_OUTCOME.UNKNOWN, 'without a page count the flat floor applies');
    const r = detect(stray, registry(), { pageCount: 5 });
    assert.equal(r.outcome, DETECT_OUTCOME.NO_TEXT);
    assert.equal(r.threshold, 500);
    // A real single page clears it.
    assert.equal(detect(CHEQUING_TEXT, registry(), { pageCount: 1 }).outcome, DETECT_OUTCOME.MATCH);
  });

  test('a non-string is treated as no text, not as a crash', () => {
    assert.equal(detect(null, registry()).outcome, DETECT_OUTCOME.NO_TEXT);
    assert.equal(detect(undefined, registry()).outcome, DETECT_OUTCOME.NO_TEXT);
  });
});

describe('the registry refuses what would make detection meaningless', () => {
  test('a duplicate id', () => {
    const r = registry();
    assert.throws(() => registerFingerprint(r, { id: 'example-chequing', must: ['x'] }), /already registered/);
  });

  test('a fingerprint with no must-pattern (would match everything)', () => {
    assert.throws(() => registerFingerprint(createRegistry(), { id: 'anything', must: [] }), /at least one pattern/);
  });

  test('a pattern that is neither RegExp nor non-empty string', () => {
    assert.throws(() => registerFingerprint(createRegistry(), { id: 'bad', must: [''] }), /RegExp or a non-empty string/);
    assert.throws(() => registerFingerprint(createRegistry(), { id: 'bad2', must: [42] }), /RegExp or a non-empty string/);
  });

  test('registries are values — two apps never share one', () => {
    const a = registry();
    const b = createRegistry();
    assert.equal(a.fingerprints.length, 2);
    assert.equal(b.fingerprints.length, 0);
    assert.equal(detect(INVESTMENT_TEXT, b).outcome, DETECT_OUTCOME.UNKNOWN);
  });
});
