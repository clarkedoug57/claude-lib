/**
 * lifecycle.js — the statement lifecycle, in one fixed order.
 *
 * class: service. Imports the StatementStore port and nothing else. Never
 * looks inside an item, never derives a period, never names a table. The
 * app's store owns every fact; this service owns only the SEQUENCE and the
 * failure rule, so that every statement type — from any issuer, into any app
 * — gets the identical lifecycle by construction.
 *
 * THE SEQUENCE (LIFECYCLE_STEPS, in order)
 *   1. findStatementByDocumentHash   per document: is it already held? (re-import)
 *   2. findPriorStatements           per scope: the records already held
 *   3. captureSupersededItems        per scope: what the wipe will remove
 *   4. supersedeItems                per scope: statement = gospel        LOAD-BEARING
 *   5. upsertStatementRecord         per section: one record, reused if held  LOAD-BEARING
 *   6. insertItems                   once: every item with its owner       LOAD-BEARING
 *   7. writeAnchor                   per period: the closing anchor        DEGRADABLE
 *   8. reconcile                     once: the reconciliation report       DEGRADABLE
 *
 * WHY THE ORDER IS THE INVARIANT
 *   capture before wipe   — judgment on the rows being removed must be read
 *                           while they still exist
 *   wipe before record    — a record's prior siblings are found by the wipe's
 *                           scope; recording first would make the new record
 *                           its own prior
 *   record before items   — every item carries its statement's id
 *   items before anchor   — the anchor is derived from what is now true
 *   anchor before reconcile — the reconciliation reads the anchor
 *
 * FAILURE RULE
 *   A load-bearing step that throws ends the import: restore is called with
 *   every capture, the report says which step failed and whether restore
 *   succeeded, and the report is RETURNED (never thrown) so the caller can
 *   render it. A read step (1–3) that throws also ends the import, with
 *   nothing to restore. A degradable step that throws is recorded as a
 *   warning and the import completes.
 */

import { STATEMENT_STORE_METHODS, LOAD_BEARING_STEPS, DEGRADABLE_STEPS } from '../../../ports/statement-store/src/index.js';

export const LIFECYCLE_STEPS = Object.freeze([...STATEMENT_STORE_METHODS.filter((m) => m !== 'restore')]);

export const IMPORT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  FAILED: 'failed',
});

/** The store must implement every port method, or the lifecycle refuses to start. */
export function assertStatementStore(store) {
  if (!store || typeof store !== 'object') {
    throw new TypeError('importStatement: a StatementStore is required');
  }
  const missing = STATEMENT_STORE_METHODS.filter((m) => typeof store[m] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`importStatement: the store does not implement ${missing.join(', ')}`);
  }
}

const hasHash = (d) => !!d && typeof d.hash === 'string' && d.hash.length > 0;

/**
 * The document a section came from: its own, else the bundle's. A batch that
 * parsed several documents together (one wizard drop of several PDFs) is ONE
 * lifecycle run over several documents — dedup runs per document, the anchor
 * and the reconciliation run once per period, exactly as a single-document
 * run would.
 */
export function documentOf(bundle, section) {
  return hasHash(section?.document) ? section.document : bundle.document;
}

/** A bundle must name a document for every section and give every section an account and a period. */
export function validateBundle(bundle) {
  const problems = [];
  if (!bundle || typeof bundle !== 'object') problems.push('bundle is required');
  else {
    if (bundle.document != null && !hasHash(bundle.document)) {
      problems.push('document.hash is required when a bundle-level document is given — it is the dedup key');
    }
    if (!Array.isArray(bundle.sections) || bundle.sections.length === 0) {
      problems.push('sections must be a non-empty array');
    } else {
      bundle.sections.forEach((s, i) => {
        if (!s || typeof s.accountKey !== 'string' || s.accountKey.length === 0) problems.push(`sections[${i}].accountKey is required`);
        if (!s?.period || typeof s.period.start !== 'string' || typeof s.period.end !== 'string') problems.push(`sections[${i}].period {start, end} is required`);
        else if (s.period.start > s.period.end) problems.push(`sections[${i}].period starts after it ends`);
        if (!Array.isArray(s?.items)) problems.push(`sections[${i}].items must be an array`);
        if (s && s.document != null && !hasHash(s.document)) problems.push(`sections[${i}].document.hash is required when a section names its document`);
        if (s && !hasHash(documentOf(bundle, s))) problems.push(`sections[${i}] resolves to no document — give the bundle a document or the section its own`);
      });
    }
  }
  if (problems.length > 0) throw new TypeError(`importStatement: invalid bundle — ${problems.join('; ')}`);
}

/** Unique documents across the bundle, first-seen order. */
export function documentsOf(bundle) {
  const seen = new Map();
  for (const s of bundle.sections) {
    const d = documentOf(bundle, s);
    if (!seen.has(d.hash)) seen.set(d.hash, { hash: d.hash, name: d.name ?? null });
  }
  return [...seen.values()];
}

const scopeKey = (s) => `${s.accountKey}|${s.period.start}|${s.period.end}`;
const periodKey = (p) => `${p.start}|${p.end}`;

/** Unique (accountKey, period) pairs, first-seen order. */
export function scopesOf(bundle) {
  const seen = new Map();
  for (const s of bundle.sections) {
    const k = scopeKey(s);
    if (!seen.has(k)) seen.set(k, { accountKey: s.accountKey, period: { start: s.period.start, end: s.period.end } });
  }
  return [...seen.values()];
}

/** Unique periods, first-seen order, each with the sections it covers. */
export function periodsOf(bundle) {
  const seen = new Map();
  bundle.sections.forEach((s, index) => {
    const k = periodKey(s.period);
    if (!seen.has(k)) seen.set(k, { period: { start: s.period.start, end: s.period.end }, sectionIndexes: [] });
    seen.get(k).sectionIndexes.push(index);
  });
  return [...seen.values()];
}

function newBatchId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function pushWarnings(report, step, warnings) {
  for (const w of warnings || []) report.warnings.push({ step, message: typeof w === 'string' ? w : (w?.message || String(w)) });
}

/**
 * Run the lifecycle for one bundle against one store.
 * @param {{ store: object, bundle: object, batchId?: string }} args
 * @returns {Promise<object>} the report — never throws for a store failure
 */
export async function importStatement({ store, bundle, batchId } = {}) {
  assertStatementStore(store);
  validateBundle(bundle);

  const id = batchId || newBatchId();
  const report = {
    batchId: id,
    status: IMPORT_STATUS.COMPLETE,
    reimport: { matched: false, prior: null, documents: [] },
    scopes: [],
    statements: [],
    items: null,
    anchors: [],
    reconciliation: null,
    warnings: [],
    failed: null,
    steps: [],
  };
  const captures = [];
  const scopes = scopesOf(bundle);

  const fail = async (step, error) => {
    report.status = IMPORT_STATUS.FAILED;
    let restored = null;
    if (LOAD_BEARING_STEPS.includes(step)) {
      try {
        const r = await store.restore({ captures, batchId: id });
        restored = { ok: true, restored: r?.restored ?? null };
      } catch (restoreErr) {
        restored = { ok: false, message: restoreErr?.message || String(restoreErr) };
      }
    }
    report.failed = { step, message: error?.message || String(error), restored };
    return report;
  };

  try {
    // 1. dedup — once per distinct document in the bundle
    report.steps.push('findStatementByDocumentHash');
    for (const doc of documentsOf(bundle)) {
      const prior = await store.findStatementByDocumentHash({ hash: doc.hash });
      report.reimport.documents.push({ hash: doc.hash, name: doc.name, matched: !!prior, prior: prior || null });
      if (prior && !report.reimport.matched) {
        report.reimport.matched = true;
        report.reimport.prior = prior;
      }
    }

    // 2. prior records per scope
    report.steps.push('findPriorStatements');
    for (const scope of scopes) {
      const ids = await store.findPriorStatements({ scope });
      report.scopes.push({ ...scope, priorStatementIds: Array.isArray(ids) ? ids : [], captured: null, removed: null });
    }

    // 3. capture, every scope, before any removal
    report.steps.push('captureSupersededItems');
    for (const s of report.scopes) {
      const capture = await store.captureSupersededItems({
        scope: { accountKey: s.accountKey, period: s.period },
        priorStatementIds: s.priorStatementIds,
        batchId: id,
      });
      captures.push({ scope: { accountKey: s.accountKey, period: s.period }, capture });
      s.captured = capture?.count ?? null;
    }
  } catch (err) {
    return fail(report.steps[report.steps.length - 1], err);
  }

  // 4. supersede — LOAD-BEARING
  report.steps.push('supersedeItems');
  try {
    for (let i = 0; i < report.scopes.length; i++) {
      const s = report.scopes[i];
      const r = await store.supersedeItems({ scope: captures[i].scope, capture: captures[i].capture, batchId: id });
      s.removed = r?.removed ?? null;
      pushWarnings(report, 'supersedeItems', r?.warnings);
    }
  } catch (err) {
    return fail('supersedeItems', err);
  }

  // 5. record — LOAD-BEARING
  report.steps.push('upsertStatementRecord');
  const statementIds = [];
  try {
    for (const section of bundle.sections) {
      const r = await store.upsertStatementRecord({ section, document: documentOf(bundle, section), batchId: id });
      if (!r || r.statementId == null) throw new Error('upsertStatementRecord returned no statementId');
      statementIds.push(r.statementId);
      report.statements.push({ accountKey: section.accountKey, period: section.period, statementId: r.statementId, created: r.created === true });
      pushWarnings(report, 'upsertStatementRecord', r.warnings);
    }
  } catch (err) {
    return fail('upsertStatementRecord', err);
  }

  // 6. items — LOAD-BEARING
  report.steps.push('insertItems');
  try {
    const r = await store.insertItems({
      sections: bundle.sections.map((section, i) => ({ section, statementId: statementIds[i] })),
      captures,
      batchId: id,
    });
    report.items = { inserted: r?.inserted ?? 0, skipped: r?.skipped ?? 0, review: r?.review ?? null };
    pushWarnings(report, 'insertItems', r?.warnings);
  } catch (err) {
    return fail('insertItems', err);
  }

  // 7. anchor per period — DEGRADABLE
  report.steps.push('writeAnchor');
  for (const p of periodsOf(bundle)) {
    try {
      const r = await store.writeAnchor({
        period: p.period,
        sections: p.sectionIndexes.map((i) => bundle.sections[i]),
        statementIds: p.sectionIndexes.map((i) => statementIds[i]),
        batchId: id,
      });
      report.anchors.push({ period: p.period, anchorId: r?.anchorId ?? null });
      pushWarnings(report, 'writeAnchor', r?.warnings);
    } catch (err) {
      report.anchors.push({ period: p.period, anchorId: null, error: err?.message || String(err) });
      report.warnings.push({ step: 'writeAnchor', message: err?.message || String(err) });
    }
  }

  // 8. reconcile — DEGRADABLE
  report.steps.push('reconcile');
  try {
    report.reconciliation = await store.reconcile({ periods: periodsOf(bundle).map((p) => p.period), batchId: id });
  } catch (err) {
    report.reconciliation = null;
    report.warnings.push({ step: 'reconcile', message: err?.message || String(err) });
  }

  return report;
}

export { LOAD_BEARING_STEPS, DEGRADABLE_STEPS };
