/**
 * @claude-lib/statement-store — the port a statement lifecycle asks an app for.
 *
 * class: port. An interface only. The method list and the contract each method
 * keeps are declared here as data; nothing in this file runs. An app implements
 * the port ONCE for its own store, and every statement type it ever imports —
 * chequing, credit card, line of credit, investment — inherits the identical
 * lifecycle from services/statement-lifecycle by construction.
 *
 * VOCABULARY (deliberately not any app's)
 *   accountKey   the app's own identity for an account, opaque to the service
 *   period       { start, end }  ISO dates, inclusive
 *   scope        { accountKey, period }  — the unit of supersession
 *   document     { hash, name }  the source document; `hash` is the dedup key.
 *                A bundle names one document, or each section names its own
 *                (several documents parsed together are ONE lifecycle run)
 *   section      one account's part of a statement (see SectionBundle)
 *   items        the statement's lines for a section, OPAQUE to the service —
 *                the store knows their shape, the lifecycle never looks inside
 *   capture      whatever the store needs to put superseded items back,
 *                opaque to the service, threaded from capture to insert to
 *                restore unchanged
 *
 * THE CONTRACT EACH METHOD KEEPS
 *   findStatementByDocumentHash({ hash })
 *       → the prior statement record for this exact document, or null.
 *         A match means RE-IMPORT: the lifecycle replaces the period; it never
 *         skips.
 *   findPriorStatements({ scope })
 *       → ids of every statement record already held for (accountKey, period).
 *   captureSupersededItems({ scope, priorStatementIds, batchId })
 *       → { count, ...opaque }. Everything the gospel wipe is about to remove:
 *         every item in the scope's period regardless of who entered it, PLUS
 *         every item owned by a prior record even when dated outside the
 *         period. Captured BEFORE removal so user judgment on those rows can
 *         be re-applied and so a failed import can be restored.
 *   supersedeItems({ scope, capture, batchId })            LOAD-BEARING
 *       → { removed }. Statement = gospel: remove what was captured.
 *   upsertStatementRecord({ section, document, batchId })  LOAD-BEARING
 *       → { statementId, created, warnings? }. One record per
 *         (accountKey × period × document). A record already held for this
 *         document is REUSED, never duplicated; its document metadata may be
 *         refreshed. A failure to store the document itself is a warning,
 *         not a throw — the record is the load-bearing part.
 *   insertItems({ sections:[{ section, statementId }], captures, batchId })  LOAD-BEARING
 *       → { inserted, skipped?, review?, warnings? }. Every item carries its
 *         statement's id (ownership). Captured judgment is re-applied by the
 *         store's own identity rule; what matched nothing is SURFACED in
 *         `review`, never dropped.
 *   writeAnchor({ period, sections, statementIds, batchId })   DEGRADABLE
 *       → { anchorId, warnings? }. The closing balances become the anchor
 *         from which the app derives state forward.
 *   reconcile({ periods, batchId })                             DEGRADABLE
 *       → the app's reconciliation report for the imported periods, recorded
 *         by the store where the app keeps audit history.
 *   restore({ captures, batchId })
 *       → { restored }. Undo this batch: remove what it inserted, put every
 *         captured item back. Called by the lifecycle when a LOAD-BEARING
 *         step throws. Never called otherwise.
 *
 * LOAD-BEARING vs DEGRADABLE
 *   A load-bearing step that throws aborts the import; the lifecycle calls
 *   restore and reports the failure. A degradable step that throws is
 *   reported as a warning and the import completes — the rows are already
 *   true; what failed is a derived artefact the app can regenerate.
 *
 * @typedef {{ start: string, end: string }} Period
 * @typedef {{ accountKey: string, period: Period }} Scope
 * @typedef {{ hash: string, name?: string|null, bytes?: unknown }} StatementDocument
 * @typedef {{ balance: number, printed: boolean }} BalanceAnchor
 * @typedef {{ accountKey: string, period: Period, currency?: string|null,
 *             opening?: BalanceAnchor|null, closing?: BalanceAnchor|null,
 *             items: unknown[], document?: StatementDocument, extras?: unknown }} SectionBundle
 * @typedef {{ document?: StatementDocument, sections: SectionBundle[], extras?: unknown }} ImportBundle
 */

/** Every method a StatementStore implements, in lifecycle order. */
export const STATEMENT_STORE_METHODS = Object.freeze([
  'findStatementByDocumentHash',
  'findPriorStatements',
  'captureSupersededItems',
  'supersedeItems',
  'upsertStatementRecord',
  'insertItems',
  'writeAnchor',
  'reconcile',
  'restore',
]);

/** A throw here aborts the import and triggers restore. */
export const LOAD_BEARING_STEPS = Object.freeze(['supersedeItems', 'upsertStatementRecord', 'insertItems']);

/** A throw here is a warning; the import completes. */
export const DEGRADABLE_STEPS = Object.freeze(['writeAnchor', 'reconcile']);
