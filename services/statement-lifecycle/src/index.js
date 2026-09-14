/**
 * @claude-lib/statement-lifecycle — the statement lifecycle behind a store port.
 *
 *   importStatement({ store, bundle, batchId? })   run the lifecycle; returns a report, never throws for a store failure
 *   bundleFromStatement(statement, { document, resolveAccountKey })
 *                                                   the canonical Statement → ImportBundle projection
 *   assertStatementStore(store)                    the conformance check the lifecycle runs first
 *   validateBundle(bundle)                         the bundle check the lifecycle runs second
 *   scopesOf(bundle) / periodsOf(bundle)           the supersession units and the anchor units
 *   LIFECYCLE_STEPS / IMPORT_STATUS / LOAD_BEARING_STEPS / DEGRADABLE_STEPS
 */

export {
  importStatement,
  assertStatementStore,
  validateBundle,
  scopesOf,
  periodsOf,
  LIFECYCLE_STEPS,
  IMPORT_STATUS,
  LOAD_BEARING_STEPS,
  DEGRADABLE_STEPS,
} from './lifecycle.js';

export { bundleFromStatement } from './bundle.js';
