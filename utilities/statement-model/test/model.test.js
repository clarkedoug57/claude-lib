/**
 * statement-model — the fixture suite.
 *
 * Proves three things: a well-formed statement validates; every class of
 * malformation is REJECTED with a path that names it (a validator never seen
 * to fail has not been proven to validate); and the strict tool schema is the
 * model itself, frozen. The synthetic statement here is the S248 panel-2
 * example: one chequing section, three lines, running balances printed.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStatement,
  statementToolSchema,
  sectionToReconcileInput,
  STATEMENT_SCHEMA,
  STRICT_UNSUPPORTED_KEYWORDS,
  validateAgainst,
} from '../src/index.js';

export function sampleStatement() {
  return {
    issuer: 'Example Bank',
    documentType: 'chequing',
    currency: 'CAD',
    period: { start: '2026-07-30', end: '2026-08-30' },
    sections: [
      {
        identity: { accountNumber: '12-34567', holders: ['HOLDER-1', 'HOLDER-2'], label: 'no fee chequing' },
        period: null,
        opening: { balance: 1965.84, printed: true },
        closing: { balance: 1558.48, printed: true },
        items: [
          { date: '2026-08-01', effectiveDate: null, description: 'PAYROLL DEPOSIT', amount: 5250.01, runningBalance: 7215.85, page: 1, sequence: 0, category: null },
          { date: '2026-08-05', effectiveDate: '2026-08-06', description: 'BILL PAYMENT HYDRO', amount: -157.37, runningBalance: 7058.48, page: 1, sequence: 1, category: 'utilities' },
          { date: '2026-08-20', effectiveDate: null, description: 'TRANSFER OUT', amount: -5500.00, runningBalance: 1558.48, page: 2, sequence: 2, category: null },
        ],
        positions: null,
      },
    ],
    ignored: [
      { page: 3, text: 'Interest rate table', reason: 'informational footer, no transaction' },
    ],
  };
}

describe('a well-formed statement', () => {
  test('validates with no errors', () => {
    const r = validateStatement(sampleStatement());
    assert.deepEqual(r, { ok: true, errors: [] });
  });

  test('maps to the reconcile gate with signed amounts untouched', () => {
    const input = sectionToReconcileInput(sampleStatement().sections[0]);
    assert.equal(input.opening.balance, 1965.84);
    assert.equal(input.closing.balance, 1558.48);
    assert.equal(input.closing.printed, true);
    assert.deepEqual(input.items.map((i) => i.amount), [5250.01, -157.37, -5500]);
    assert.deepEqual(input.items.map((i) => i.runningBalance), [7215.85, 7058.48, 1558.48]);
    assert.deepEqual(input.items.map((i) => i.sequence), ['000000', '000001', '000002']);
  });
});

describe('malformations are rejected, each named by path', () => {
  const cases = [
    ['a missing section list', (s) => { delete s.sections; }, '/sections', /required/],
    ['an empty section list', (s) => { s.sections = []; }, '/sections', /at least 1/],
    ['a property outside the model', (s) => { s.sections[0].items[0].note = 'x'; }, '/sections/0/items/0/note', /not in the model/],
    ['a non-ISO date', (s) => { s.sections[0].items[1].date = 'Aug 5, 2026'; }, '/sections/0/items/1/date', /does not match/],
    ['a string amount', (s) => { s.sections[0].items[0].amount = '5250.01'; }, '/sections/0/items/0/amount', /expected number/],
    ['a NaN amount', (s) => { s.sections[0].items[0].amount = Number.NaN; }, '/sections/0/items/0/amount', /expected number/],
    ['a zero page number', (s) => { s.sections[0].items[2].page = 0; }, '/sections/0/items/2/page', /below the minimum/],
    ['a fractional sequence', (s) => { s.sections[0].items[2].sequence = 1.5; }, '/sections/0/items/2/sequence', /expected integer/],
    ['an omitted optional field (must be explicit null)', (s) => { delete s.sections[0].items[0].runningBalance; }, '/sections/0/items/0/runningBalance', /required/],
    ['a lowercase currency', (s) => { s.currency = 'cad'; }, '/currency', /does not match/],
    ['an ignored row without a reason', (s) => { s.ignored[0].reason = ''; }, '/ignored/0/reason', /shorter than 1/],
    ['an empty account number', (s) => { s.sections[0].identity.accountNumber = ''; }, '/sections/0/identity/accountNumber', /shorter than 1/],
  ];
  for (const [name, mutate, path, message] of cases) {
    test(name, () => {
      const s = sampleStatement();
      mutate(s);
      const r = validateStatement(s);
      assert.equal(r.ok, false, `expected a failure for ${name}`);
      const hit = r.errors.find((e) => e.path === path);
      assert.ok(hit, `no error at ${path}; got ${JSON.stringify(r.errors)}`);
      assert.match(hit.message, message);
    });
  }

  test('the error list is complete, not first-failure-only', () => {
    const s = sampleStatement();
    delete s.issuer;
    s.currency = 'x';
    s.sections[0].items[0].page = 0;
    const r = validateStatement(s);
    assert.equal(r.errors.length, 3, JSON.stringify(r.errors));
  });
});

describe('the strict tool schema', () => {
  test('is the model with the strict-unsupported constraints stripped, and is frozen', () => {
    const tool = statementToolSchema();
    // Same structure: every property path present in the model is present here.
    const paths = (s, p = '') => Object.keys(s.properties || {}).flatMap((k) => [`${p}/${k}`, ...paths(s.properties[k].items || s.properties[k], `${p}/${k}`)]);
    assert.deepEqual(paths(tool), paths(STATEMENT_SCHEMA));
    // But no constraint keyword survives anywhere in it.
    const walk = (node, found = []) => {
      if (Array.isArray(node)) node.forEach((n) => walk(n, found));
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (STRICT_UNSUPPORTED_KEYWORDS.includes(k)) found.push(k); walk(v, found); }
      return found;
    };
    assert.deepEqual(walk(tool), []);
    assert.ok(walk(STATEMENT_SCHEMA).length > 0, 'the model itself keeps its constraints for the validator');
    assert.equal(tool.properties.currency.pattern, undefined);
    assert.equal(tool.properties.sections.items.properties.items.items.properties.page.type, 'integer');
    assert.ok(Object.isFrozen(tool));
    assert.ok(Object.isFrozen(tool.properties.sections.items.properties.items.items));
    assert.throws(() => { tool.properties.extra = {}; }, TypeError);
  });

  test('every object in the model closes additionalProperties and lists required', () => {
    const walk = (schema, path) => {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (types.includes('object')) {
        assert.equal(schema.additionalProperties, false, `${path} does not close additionalProperties`);
        assert.deepEqual([...(schema.required || [])].sort(), Object.keys(schema.properties || {}).sort(), `${path}: required must list every property (strict tools)`);
        for (const [k, sub] of Object.entries(schema.properties || {})) walk(sub, `${path}/${k}`);
      }
      if (schema.items) walk(schema.items, `${path}/[]`);
    };
    walk(STATEMENT_SCHEMA, '');
  });

  test('the validator refuses a schema keyword it does not implement', () => {
    assert.throws(() => validateAgainst({ type: 'string', format: 'date' }, '2026-01-01'), /not implemented/);
  });
});
