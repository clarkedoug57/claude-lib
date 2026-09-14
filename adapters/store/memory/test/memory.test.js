/**
 * The memory store on its own: conformance to the port, the seed helpers, an
 * opaque (non-canonical) item reconciling as unverifiable rather than as a
 * pass, and failAt naming a method.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStatementStore } from '../src/index.js';
import { STATEMENT_STORE_METHODS } from '../../../../ports/statement-store/src/index.js';

test('implements every port method', () => {
  const store = createMemoryStatementStore();
  for (const m of STATEMENT_STORE_METHODS) assert.equal(typeof store[m], 'function', m);
});

test('an item without an amount reconciles as unverifiable, never balanced', async () => {
  const store = createMemoryStatementStore();
  const period = { start: '2026-08-01', end: '2026-08-31' };
  const { statementId } = await store.upsertStatementRecord({
    section: { accountKey: 'a', period, opening: { balance: 1, printed: true }, closing: { balance: 1, printed: true }, items: [] },
    document: { hash: 'h' }, batchId: 'b',
  });
  await store.insertItems({ sections: [{ section: { accountKey: 'a', period, items: [{ date: '2026-08-02', opaque: true }] }, statementId }], captures: [], batchId: 'b' });
  const r = await store.reconcile({ periods: [period], batchId: 'b' });
  assert.equal(r.periods[0].sections[0].status, 'unverifiable');
  assert.equal(r.periods[0].verdict, 'unverifiable');
});

test('a period with no statement reconciles as no-statement', async () => {
  const store = createMemoryStatementStore();
  const r = await store.reconcile({ periods: [{ start: '2026-01-01', end: '2026-01-31' }], batchId: 'b' });
  assert.equal(r.periods[0].verdict, 'no-statement');
});

test('failAt throws at exactly that method and is logged first', async () => {
  const store = createMemoryStatementStore({ failAt: 'writeAnchor' });
  await store.findPriorStatements({ scope: { accountKey: 'a', period: { start: '2026-01-01', end: '2026-01-31' } } });
  await assert.rejects(() => store.writeAnchor({ period: {}, sections: [], batchId: 'b' }), /forced failure at writeAnchor/);
  assert.deepEqual(store.state.calls, ['findPriorStatements', 'writeAnchor']);
});
