/**
 * @claude-lib/store-memory — an in-memory StatementStore.
 *
 * class: adapter. Implements the StatementStore port for plain arrays. Two
 * jobs: the lifecycle's own proof (call order, re-import, restore), and a
 * test double for any app that wants to exercise the lifecycle without its
 * database.
 *
 * Items are stored as given plus the fields the store adds (id, accountKey,
 * statementId, batchId). Reconciliation reads `amount`, `date`, `runningBalance`
 * off each item — the canonical LineItem shape. An item without `amount`
 * reconciles as unverifiable, which is the honest verdict for an opaque row.
 *
 * `failAt` names a method that throws when called — the way a test proves
 * the lifecycle restores on a load-bearing failure and degrades on the other
 * kind. `calls` is the ordered log of every method invoked.
 */

import { STATEMENT_STORE_METHODS } from '../../../../ports/statement-store/src/index.js';
import { reconcile as reconcileCore } from '../../../../utilities/statement-core/src/index.js';

export function createMemoryStatementStore({ failAt = null } = {}) {
  const state = {
    statements: [],
    items: [],
    anchors: [],
    reconciliations: [],
    calls: [],
  };
  let seq = 0;
  const nextId = (prefix) => `${prefix}-${++seq}`;

  const log = (name) => {
    state.calls.push(name);
    if (failAt === name) throw new Error(`memory store: forced failure at ${name}`);
  };

  const inPeriod = (item, scope) =>
    item.accountKey === scope.accountKey
    && typeof item.date === 'string'
    && item.date >= scope.period.start
    && item.date <= scope.period.end;

  const store = {
    state,

    /** Seed pre-existing state the way an app's database would hold it. */
    seed: {
      statement({ accountKey, period, documentHash, documentName = null, currency = null, opening = null, closing = null }) {
        const row = { id: nextId('stmt'), accountKey, period: { ...period }, documentHash, documentName, currency, opening, closing, batchId: null };
        state.statements.push(row);
        return row.id;
      },
      item({ accountKey, date, amount = null, description = '', statementId = null, source = 'seed', ...rest }) {
        const row = { id: nextId('item'), accountKey, date, amount, description, statementId, source, batchId: null, ...rest };
        state.items.push(row);
        return row.id;
      },
    },

    async findStatementByDocumentHash({ hash }) {
      log('findStatementByDocumentHash');
      return state.statements.find((s) => s.documentHash === hash) || null;
    },

    async findPriorStatements({ scope }) {
      log('findPriorStatements');
      return state.statements
        .filter((s) => s.accountKey === scope.accountKey && s.period.end === scope.period.end)
        .map((s) => s.id);
    },

    async captureSupersededItems({ scope, priorStatementIds }) {
      log('captureSupersededItems');
      const owned = new Set(priorStatementIds || []);
      const rows = state.items.filter((it) => inPeriod(it, scope) || (it.statementId && owned.has(it.statementId)));
      return { count: rows.length, rows: rows.map((r) => ({ ...r })) };
    },

    async supersedeItems({ scope, capture }) {
      log('supersedeItems');
      const ids = new Set((capture?.rows || []).map((r) => r.id));
      const before = state.items.length;
      state.items = state.items.filter((it) => !ids.has(it.id));
      return { removed: before - state.items.length, scope };
    },

    async upsertStatementRecord({ section, document, batchId }) {
      log('upsertStatementRecord');
      const existing = state.statements.find((s) =>
        s.accountKey === section.accountKey && s.period.end === section.period.end && s.documentHash === document.hash);
      if (existing) {
        existing.documentName = document.name ?? existing.documentName;
        return { statementId: existing.id, created: false };
      }
      const row = {
        id: nextId('stmt'),
        accountKey: section.accountKey,
        period: { ...section.period },
        documentHash: document.hash,
        documentName: document.name ?? null,
        currency: section.currency ?? null,
        opening: section.opening ?? null,
        closing: section.closing ?? null,
        batchId,
      };
      state.statements.push(row);
      return { statementId: row.id, created: true };
    },

    async insertItems({ sections, batchId }) {
      log('insertItems');
      let inserted = 0;
      for (const { section, statementId } of sections) {
        (section.items || []).forEach((item, i) => {
          state.items.push({
            ...item,
            id: nextId('item'),
            accountKey: section.accountKey,
            statementId,
            batchId,
            source: 'statement',
            sequence: item.sequence ?? i,
          });
          inserted++;
        });
      }
      return { inserted, skipped: 0, review: null };
    },

    async writeAnchor({ period, sections, batchId }) {
      log('writeAnchor');
      const row = {
        id: nextId('anchor'),
        period: { ...period },
        closings: sections.map((s) => ({ accountKey: s.accountKey, balance: s.closing?.balance ?? null })),
        batchId,
      };
      state.anchors.push(row);
      return { anchorId: row.id };
    },

    async reconcile({ periods, batchId }) {
      log('reconcile');
      const out = { periods: [] };
      for (const period of periods) {
        const sections = [];
        for (const stmt of state.statements.filter((s) => s.period.end === period.end)) {
          const items = state.items
            .filter((it) => it.statementId === stmt.id)
            .map((it, i) => ({
              id: it.id, kind: 'line', date: it.date,
              sequence: String(it.sequence ?? i).padStart(6, '0'),
              amount: it.amount ?? null, runningBalance: it.runningBalance ?? null,
            }));
          let status;
          if (!stmt.opening || !stmt.closing) status = 'unverifiable';
          else status = reconcileCore({
            opening: { balance: stmt.opening.balance },
            closing: { balance: stmt.closing.balance, printed: stmt.closing.printed === true },
            items,
          }).status;
          sections.push({ accountKey: stmt.accountKey, statementId: stmt.id, status });
        }
        const verdict = sections.length === 0 ? 'no-statement'
          : sections.every((s) => s.status === 'balanced') ? 'balanced'
            : sections.some((s) => s.status === 'out-of-balance') ? 'out-of-balance' : 'unverifiable';
        out.periods.push({ period: { ...period }, sections, verdict });
      }
      state.reconciliations.push({ batchId, ...out });
      return out;
    },

    async restore({ captures, batchId }) {
      log('restore');
      state.items = state.items.filter((it) => it.batchId !== batchId);
      state.statements = state.statements.filter((s) => s.batchId !== batchId);
      state.anchors = state.anchors.filter((a) => a.batchId !== batchId);
      let restored = 0;
      for (const { capture } of captures || []) {
        for (const row of capture?.rows || []) {
          if (!state.items.some((it) => it.id === row.id)) { state.items.push({ ...row }); restored++; }
        }
      }
      return { restored };
    },
  };

  for (const m of STATEMENT_STORE_METHODS) {
    if (typeof store[m] !== 'function') throw new Error(`memory store: missing ${m}`);
  }
  return store;
}
