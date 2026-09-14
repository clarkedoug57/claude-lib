/**
 * The lifecycle, proven on the memory store: the call ORDER is the invariant;
 * re-import replaces, never duplicates; a row owned by a prior record is
 * removed even when dated outside the period; a load-bearing failure restores
 * and reports; a degradable failure warns and completes; a store missing a
 * method is refused before anything runs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  importStatement, assertStatementStore, validateBundle, scopesOf, periodsOf,
  LIFECYCLE_STEPS, IMPORT_STATUS, LOAD_BEARING_STEPS, DEGRADABLE_STEPS,
} from '../src/index.js';
import { STATEMENT_STORE_METHODS } from '../../../ports/statement-store/src/index.js';
import { createMemoryStatementStore } from '../../../adapters/store/memory/src/index.js';

const P = { start: '2026-08-01', end: '2026-08-31' };

function bundle({ hash = 'doc-1', name = 'aug.pdf' } = {}) {
  return {
    document: { hash, name },
    sections: [
      {
        accountKey: 'chequing', period: P, currency: 'CAD',
        opening: { balance: 100, printed: true }, closing: { balance: 70, printed: true },
        items: [
          { date: '2026-08-03', description: 'GROCER', amount: -40 },
          { date: '2026-08-10', description: 'PAYROLL', amount: 10 },
        ],
      },
      {
        accountKey: 'visa', period: P, currency: 'CAD',
        opening: { balance: 0, printed: true }, closing: { balance: 25.5, printed: true },
        items: [{ date: '2026-08-15', description: 'COFFEE', amount: 25.5 }],
      },
    ],
  };
}

describe('the sequence', () => {
  test('LIFECYCLE_STEPS is the port method list minus restore, in port order', () => {
    assert.deepEqual([...LIFECYCLE_STEPS], STATEMENT_STORE_METHODS.filter((m) => m !== 'restore'));
    for (const s of LOAD_BEARING_STEPS) assert.ok(LIFECYCLE_STEPS.includes(s));
    for (const s of DEGRADABLE_STEPS) assert.ok(LIFECYCLE_STEPS.includes(s));
  });

  test('a first import calls every step, in order, once per unit', async () => {
    const store = createMemoryStatementStore();
    const report = await importStatement({ store, bundle: bundle() });
    assert.equal(report.status, IMPORT_STATUS.COMPLETE);
    assert.equal(report.failed, null);
    assert.deepEqual(store.state.calls, [
      'findStatementByDocumentHash',
      'findPriorStatements', 'findPriorStatements',          // two scopes
      'captureSupersededItems', 'captureSupersededItems',    // capture EVERY scope before ANY removal
      'supersedeItems', 'supersedeItems',
      'upsertStatementRecord', 'upsertStatementRecord',      // two sections
      'insertItems',                                          // once, all sections
      'writeAnchor',                                          // one period
      'reconcile',
    ]);
    assert.deepEqual(report.steps, [...LIFECYCLE_STEPS]);
    assert.equal(report.reimport.matched, false);
    assert.equal(report.statements.length, 2);
    assert.ok(report.statements.every((s) => s.created === true));
    assert.equal(report.items.inserted, 3);
    assert.equal(report.anchors.length, 1);
    assert.equal(report.reconciliation.periods[0].verdict, 'balanced');
    assert.deepEqual(report.warnings, []);
  });

  test('scopesOf and periodsOf collapse duplicates and keep first-seen order', () => {
    const b = bundle();
    b.sections.push({ ...b.sections[0], items: [] });
    assert.deepEqual(scopesOf(b), [{ accountKey: 'chequing', period: P }, { accountKey: 'visa', period: P }]);
    assert.deepEqual(periodsOf(b), [{ period: P, sectionIndexes: [0, 1, 2] }]);
  });
});

describe('statement = gospel', () => {
  test('a manual row in the period is captured, removed, and the report says so', async () => {
    const store = createMemoryStatementStore();
    store.seed.item({ accountKey: 'chequing', date: '2026-08-05', amount: -9.99, description: 'manual guess', source: 'manual' });
    const report = await importStatement({ store, bundle: bundle() });
    assert.equal(report.scopes[0].captured, 1);
    assert.equal(report.scopes[0].removed, 1);
    assert.equal(store.state.items.filter((i) => i.source === 'manual').length, 0);
    assert.equal(store.state.items.length, 3);
  });

  test('a row OUTSIDE the period but owned by a prior record for the scope is removed too', async () => {
    const store = createMemoryStatementStore();
    const priorId = store.seed.statement({ accountKey: 'chequing', period: P, documentHash: 'older-doc' });
    store.seed.item({ accountKey: 'chequing', date: '2026-09-01', amount: -1, description: 'pending, owned by prior', statementId: priorId });
    store.seed.item({ accountKey: 'chequing', date: '2026-09-01', amount: -2, description: 'next period, NOT owned' });
    const report = await importStatement({ store, bundle: bundle() });
    assert.deepEqual(report.scopes[0].priorStatementIds, [priorId]);
    assert.equal(report.scopes[0].removed, 1);
    const survivors = store.state.items.filter((i) => i.date === '2026-09-01');
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].description, 'next period, NOT owned');
  });

  test('re-import of the same document replaces the period and reuses the record', async () => {
    const store = createMemoryStatementStore();
    const first = await importStatement({ store, bundle: bundle() });
    const second = await importStatement({ store, bundle: bundle() });
    assert.equal(second.reimport.matched, true);
    assert.equal(second.reimport.prior.id, first.statements[0].statementId);
    assert.ok(second.statements.every((s) => s.created === false), 'records reused');
    assert.deepEqual(second.statements.map((s) => s.statementId), first.statements.map((s) => s.statementId));
    assert.equal(second.scopes[0].removed, 2);
    assert.equal(second.scopes[1].removed, 1);
    assert.equal(store.state.items.length, 3, 'no duplication');
    assert.equal(store.state.statements.length, 2);
  });

  test('a different document for the same account and period is a new record; the old one\'s items are gone', async () => {
    const store = createMemoryStatementStore();
    await importStatement({ store, bundle: bundle({ hash: 'doc-1' }) });
    const r = await importStatement({ store, bundle: bundle({ hash: 'doc-2', name: 'aug-corrected.pdf' }) });
    assert.equal(r.reimport.matched, false);
    assert.ok(r.statements.every((s) => s.created === true));
    assert.equal(store.state.statements.length, 4);
    assert.equal(store.state.items.length, 3);
    assert.ok(store.state.items.every((i) => r.statements.some((s) => s.statementId === i.statementId)), 'every item owned by the new records');
  });
});

describe('the failure rule', () => {
  for (const step of LOAD_BEARING_STEPS) {
    test(`${step} throwing ends the import, restores the capture, and is reported — not thrown`, async () => {
      const store = createMemoryStatementStore({ failAt: step });
      const seeded = store.seed.item({ accountKey: 'chequing', date: '2026-08-05', amount: -9.99, description: 'manual', source: 'manual' });
      const report = await importStatement({ store, bundle: bundle() });
      assert.equal(report.status, IMPORT_STATUS.FAILED);
      assert.equal(report.failed.step, step);
      assert.match(report.failed.message, /forced failure/);
      assert.equal(report.failed.restored.ok, true);
      assert.equal(store.state.calls[store.state.calls.length - 1], 'restore');
      assert.ok(!store.state.calls.includes('writeAnchor'), 'no anchor after a failure');
      assert.ok(!store.state.calls.includes('reconcile'), 'no reconcile after a failure');
      assert.ok(store.state.items.some((i) => i.id === seeded), 'the captured manual row is back');
      assert.equal(store.state.items.filter((i) => i.batchId === report.batchId).length, 0, 'nothing of this batch survives');
      assert.equal(store.state.statements.filter((s) => s.batchId === report.batchId).length, 0);
    });
  }

  test('a read step throwing ends the import with nothing to restore', async () => {
    const store = createMemoryStatementStore({ failAt: 'captureSupersededItems' });
    const report = await importStatement({ store, bundle: bundle() });
    assert.equal(report.status, IMPORT_STATUS.FAILED);
    assert.equal(report.failed.step, 'captureSupersededItems');
    assert.equal(report.failed.restored, null);
    assert.ok(!store.state.calls.includes('restore'));
  });

  for (const step of DEGRADABLE_STEPS) {
    test(`${step} throwing is a warning; the import completes`, async () => {
      const store = createMemoryStatementStore({ failAt: step });
      const report = await importStatement({ store, bundle: bundle() });
      assert.equal(report.status, IMPORT_STATUS.COMPLETE);
      assert.equal(report.failed, null);
      assert.equal(report.warnings.length, 1);
      assert.equal(report.warnings[0].step, step);
      assert.equal(store.state.items.length, 3, 'the rows stand');
      if (step === 'writeAnchor') {
        assert.equal(report.anchors[0].anchorId, null);
        assert.ok(store.state.calls.includes('reconcile'), 'reconcile still runs');
      } else {
        assert.equal(report.reconciliation, null);
        assert.equal(report.anchors[0].anchorId != null, true);
      }
    });
  }

  test('restore failing is reported inside the failure, never thrown', async () => {
    const store = createMemoryStatementStore({ failAt: 'insertItems' });
    const realRestore = store.restore;
    store.restore = async () => { throw new Error('restore itself broke'); };
    const report = await importStatement({ store, bundle: bundle() });
    assert.equal(report.failed.restored.ok, false);
    assert.match(report.failed.restored.message, /restore itself broke/);
    store.restore = realRestore;
  });
});

describe('refusals before anything runs', () => {
  test('a store missing a method is named', async () => {
    const store = createMemoryStatementStore();
    delete store.writeAnchor;
    await assert.rejects(() => importStatement({ store, bundle: bundle() }), /does not implement writeAnchor/);
    assert.deepEqual(store.state.calls, []);
    assert.throws(() => assertStatementStore({}), /does not implement findStatementByDocumentHash, findPriorStatements/);
  });

  test('a bundle without a document hash, a section without an account, or a period that ends before it starts is refused', () => {
    assert.throws(() => validateBundle({ document: {}, sections: [] }), /document\.hash is required.*sections must be a non-empty array/);
    assert.throws(() => validateBundle({ document: { hash: 'x' }, sections: [{ period: P, items: [] }] }), /sections\[0\]\.accountKey/);
    assert.throws(() => validateBundle({ document: { hash: 'x' }, sections: [{ accountKey: 'a', period: { start: '2026-09-01', end: '2026-08-31' }, items: [] }] }), /starts after it ends/);
    assert.throws(() => validateBundle({ document: { hash: 'x' }, sections: [{ accountKey: 'a', period: P }] }), /items must be an array/);
  });

  test('a supplied batchId is used verbatim; otherwise one is minted', async () => {
    const store = createMemoryStatementStore();
    const r = await importStatement({ store, bundle: bundle(), batchId: 'batch-42' });
    assert.equal(r.batchId, 'batch-42');
    assert.ok(store.state.items.every((i) => i.batchId === 'batch-42'));
    const r2 = await importStatement({ store: createMemoryStatementStore(), bundle: bundle() });
    assert.ok(typeof r2.batchId === 'string' && r2.batchId.length > 8);
  });
});
