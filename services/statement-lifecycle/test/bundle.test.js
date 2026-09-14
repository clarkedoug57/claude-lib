/**
 * bundleFromStatement: the canonical Statement → ImportBundle projection.
 * Items pass through untouched; the section period overrides the statement
 * period; an identity the resolver cannot place is refused, never guessed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundleFromStatement, validateBundle } from '../src/index.js';

const statement = {
  issuer: 'Example Bank',
  documentType: 'chequing',
  currency: 'CAD',
  period: { start: '2026-07-30', end: '2026-08-30' },
  sections: [
    {
      identity: { accountNumber: '····1459', holders: ['HOLDER-1'], label: 'chequing' },
      period: null,
      opening: { balance: 10, printed: true },
      closing: { balance: 5, printed: true },
      items: [{ date: '2026-08-01', effectiveDate: null, description: 'X', amount: -5, runningBalance: 5, page: 1, sequence: 0, category: null }],
      positions: null,
    },
    {
      identity: { accountNumber: '····2222', holders: ['HOLDER-1'], label: 'savings' },
      period: { start: '2026-08-01', end: '2026-08-31' },
      opening: { balance: 0, printed: false },
      closing: { balance: 0, printed: true },
      items: [],
      positions: null,
    },
  ],
  ignored: [{ page: 1, text: 'Total', reason: 'summary row' }],
};

test('projects every section, applies the resolver, passes items through untouched', () => {
  const b = bundleFromStatement(statement, {
    document: { hash: 'h1', name: 'aug.pdf' },
    resolveAccountKey: (identity) => `acct:${identity.accountNumber.slice(-4)}`,
  });
  validateBundle(b);
  assert.deepEqual(b.document, { hash: 'h1', name: 'aug.pdf' });
  assert.equal(b.sections.length, 2);
  assert.equal(b.sections[0].accountKey, 'acct:1459');
  assert.deepEqual(b.sections[0].period, { start: '2026-07-30', end: '2026-08-30' }, 'statement period when the section has none');
  assert.deepEqual(b.sections[1].period, { start: '2026-08-01', end: '2026-08-31' }, 'section period wins');
  assert.equal(b.sections[0].items, statement.sections[0].items, 'the same array, untouched');
  assert.deepEqual(b.sections[0].opening, { balance: 10, printed: true });
  assert.deepEqual(b.sections[1].opening, { balance: 0, printed: false });
  assert.equal(b.sections[0].currency, 'CAD');
  assert.deepEqual(b.sections[0].extras.identity, statement.sections[0].identity);
  assert.deepEqual(b.extras, { issuer: 'Example Bank', documentType: 'chequing', ignored: statement.ignored });
});

test('an identity the resolver cannot place is refused, naming the account number', () => {
  assert.throws(
    () => bundleFromStatement(statement, { document: { hash: 'h1' }, resolveAccountKey: (id) => (id.accountNumber.endsWith('1459') ? 'a' : null) }),
    /no account for "····2222"/,
  );
});

test('a missing document hash or resolver is a programmer error', () => {
  assert.throws(() => bundleFromStatement(statement, { resolveAccountKey: () => 'a' }), /document\.hash is required/);
  assert.throws(() => bundleFromStatement(statement, { document: { hash: 'h' } }), /resolveAccountKey is required/);
  assert.throws(() => bundleFromStatement({}, { document: { hash: 'h' }, resolveAccountKey: () => 'a' }), /sections is required/);
});
