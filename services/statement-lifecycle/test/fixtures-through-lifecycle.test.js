/**
 * Every staged fixture — chequing, credit card, line of credit; none of them
 * an investment statement, none of them from the app the lifecycle was
 * extracted from — imports through the SAME lifecycle on the memory store:
 * one record per section, every item owned, one anchor per period, every
 * section reconciled to the cent by the store; then a re-import that
 * replaces the period and duplicates nothing. This is the proof that the
 * lifecycle belongs to no app and no statement type.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStatement, bundleFromStatement, IMPORT_STATUS } from '../src/index.js';
import { createMemoryStatementStore } from '../../../adapters/store/memory/src/index.js';

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

const statements = walk(FIXTURES)
  .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), fixture: JSON.parse(fs.readFileSync(f, 'utf8')) }))
  .filter(({ fixture }) => fixture.kind === 'statement');

test('the suite covers at least three statement fixtures (never vacuous)', () => {
  assert.ok(statements.length >= 3, `only ${statements.length} statement fixtures`);
});

for (const { file, fixture } of statements) {
  describe(file, () => {
    const document = { hash: `sha256:${fixture.id}`, name: fixture.id };
    const resolveAccountKey = (identity) => `acct:${identity.accountNumber}`;
    const expectedItems = fixture.statement.sections.reduce((n, s) => n + s.items.length, 0);

    test('first import: one record per section, every item owned, one anchor per period, every section balanced', async () => {
      const store = createMemoryStatementStore();
      const bundle = bundleFromStatement(fixture.statement, { document, resolveAccountKey });
      const r = await importStatement({ store, bundle });
      assert.equal(r.status, IMPORT_STATUS.COMPLETE, JSON.stringify(r.failed));
      assert.deepEqual(r.warnings, []);
      assert.equal(r.reimport.matched, false);
      assert.equal(r.statements.length, fixture.statement.sections.length);
      assert.equal(r.items.inserted, expectedItems);
      assert.equal(store.state.items.length, expectedItems);
      assert.ok(store.state.items.every((it) => r.statements.some((s) => s.statementId === it.statementId)), 'every item owned');
      const periods = new Set(bundle.sections.map((s) => `${s.period.start}|${s.period.end}`));
      assert.equal(r.anchors.length, periods.size);
      for (const p of r.reconciliation.periods) {
        assert.equal(p.verdict, 'balanced', JSON.stringify(p));
      }
    });

    test('re-import: the period is replaced, records reused, nothing duplicated', async () => {
      const store = createMemoryStatementStore();
      const bundle = bundleFromStatement(fixture.statement, { document, resolveAccountKey });
      const first = await importStatement({ store, bundle });
      const second = await importStatement({ store, bundle });
      assert.equal(second.reimport.matched, true);
      assert.ok(second.statements.every((s) => s.created === false));
      assert.deepEqual(second.statements.map((s) => s.statementId), first.statements.map((s) => s.statementId));
      assert.equal(second.scopes.reduce((n, s) => n + s.removed, 0), expectedItems, 'the first import\'s items were superseded');
      assert.equal(store.state.items.length, expectedItems, 'no duplication');
      assert.equal(store.state.statements.length, fixture.statement.sections.length);
      for (const p of second.reconciliation.periods) assert.equal(p.verdict, 'balanced');
    });
  });
}
