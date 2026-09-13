/**
 * The staged-fixture suite: every fixture under fixtures/ is re-proven on
 * every run. A statement fixture must validate against the model AND balance
 * per section through the gate AND pass the verifier against its own raw
 * rows AND carry no redaction residual. A verdict fixture must carry a kind
 * and a reason. The scan must find at least one fixture — a suite over an
 * empty directory passes vacuously, which is not a pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStatement, sectionToReconcileInput } from '../utilities/statement-model/src/index.js';
import { reconcile } from '../utilities/statement-core/src/index.js';
import { verifyProposal } from '../agents/statement-layout/src/index.js';
import { findResiduals, FIXTURE_KIND, FIXTURE_FORMAT_VERSION } from '../utilities/statement-fixtures/src/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith('.json')) out.push(full);
  }
  return out;
}

const files = walk(FIXTURES);

test('at least one staged fixture exists (the suite must not pass vacuously)', () => {
  assert.ok(files.length >= 1, `no fixtures under ${FIXTURES}`);
});

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));

  describe(rel, () => {
    test('carries the current format version and a kind', () => {
      assert.equal(fixture.formatVersion, FIXTURE_FORMAT_VERSION);
      assert.ok(Object.values(FIXTURE_KIND).includes(fixture.kind), `unknown kind ${fixture.kind}`);
      assert.ok(fixture.id, 'fixture id missing');
    });

    if (fixture.kind === FIXTURE_KIND.STATEMENT) {
      test('validates against the canonical model', () => {
        const v = validateStatement(fixture.statement);
        assert.equal(v.ok, true, JSON.stringify(v.errors, null, 2));
      });

      test('every section balances to the cent', () => {
        for (const [i, section] of fixture.statement.sections.entries()) {
          const r = reconcile(sectionToReconcileInput(section));
          assert.equal(r.status, 'balanced', `section ${i} (${section.identity.accountNumber}): ${JSON.stringify(r.balance)}`);
        }
      });

      test('passes the verifier against its own raw rows (coverage + identity)', () => {
        const v = verifyProposal(fixture.statement, { kind: fixture.provenance?.hasTextLayer === false ? 'transcription' : 'text', pages: fixture.raw.pages });
        assert.equal(v.ok, true, JSON.stringify(v.failures, null, 2));
      });

      test('carries no redaction residual', () => {
        const holders = fixture.statement.sections.flatMap((s) => s.identity.holders);
        for (const h of holders) assert.match(h, /^HOLDER-\d+$/, `holder "${h}" is not a placeholder`);
        const texts = [
          ...fixture.raw.pages.flat(),
          ...fixture.statement.sections.flatMap((s) => [s.identity.accountNumber, ...s.items.map((i) => i.description)]),
          ...fixture.statement.ignored.map((r) => r.text),
          fixture.notes || '',
        ];
        for (const t of texts) assert.deepEqual(findResiduals(t), [], `residual in "${t}"`);
      });
    } else {
      test('a verdict fixture carries a kind and a reason', () => {
        assert.ok(fixture.verdict?.kind, 'verdict kind missing');
        assert.ok(fixture.verdict?.reason, 'verdict reason missing');
        assert.deepEqual(findResiduals(fixture.verdict.reason), []);
      });
    }
  });
}
