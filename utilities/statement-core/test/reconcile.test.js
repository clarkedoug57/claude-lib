/**
 * reconcile — the fixture suite.
 *
 * Every case below is a translation of a reconcilePeriod case from Portfolio
 * Command Center's periodAuditService.test.js into the canonical shape, with
 * the app's vocabulary already applied: a buy is amount −total, quantityDelta
 * +shares; a sell is amount +total, quantityDelta −shares; a trade's
 * expectedFee is the issuer's fee for that date. The numbers are synthetic and
 * identical to the originals, so the two suites must agree case for case.
 *
 * Translated: cash reconciliation (6), same-day ordering (3), the multi-fill
 * partial order (2), position reconciliation (4), fee integrity (2), total
 * value (2) = 19. The three anchor-handling cases stay with the app adapter,
 * which owns what a missing anchor means. Added here: the cross-check fields
 * and the unknown-kind listing (3), and the input contract (2).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, BALANCE_PATH, DEFAULT_OPTIONS } from '../src/index.js';

const FEE = 9.99;

/** A trade line. `side` 'buy' = amount out, quantity in; 'sell' = the reverse. */
function trade(side, { symbol = 'MSFT', qty, total, fee = FEE, date = '2026-04-15', runningBalance = null, sequence, id } = {}) {
  return {
    id: id ?? `item-${Math.random().toString(36).slice(2, 10)}`,
    kind: side,
    symbol,
    date,
    sequence,
    amount: side === 'buy' ? -Math.abs(total) : +Math.abs(total),
    quantityDelta: side === 'buy' ? +Math.abs(qty) : -Math.abs(qty),
    runningBalance,
    fee,
    expectedFee: FEE,
  };
}

const opening = (balance, positions = []) => ({ balance, positions });
const closing = (balance, { positions = [], printed = false } = {}) => ({ balance, positions, printed });

describe('balance — amount-sum path', () => {
  test('balanced when opening + Σ amount = closing', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(11980.02),
      items: [
        trade('buy', { qty: 100, total: 3009.99, date: '2026-04-10' }),
        trade('sell', { qty: 50, total: 4990.01, date: '2026-04-20' }),
      ],
    });
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.balance.computed, 11980.02);
    assert.equal(r.balance.variance, 0);
    assert.equal(r.balance.path, BALANCE_PATH.AMOUNT_SUM);
    assert.equal(r.status, 'balanced');
  });

  test('out-of-balance when an extra line inflates the balance', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(15960.01), // printed close counted ONE sell
      items: [
        trade('sell', { qty: 200, total: 5960.01 }),
        trade('sell', { qty: 200, total: 5960.01 }), // phantom duplicate
      ],
    });
    assert.equal(r.balance.status, 'out-of-balance');
    assert.equal(r.balance.variance, 5960.01);
    assert.equal(r.status, 'out-of-balance');
  });

  test('out-of-balance when a line is missing (negative variance)', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(15950.02), // opening + two sells; only one parsed
      items: [trade('sell', { qty: 100, total: 2975.01, fee: 0 })],
    });
    assert.equal(r.balance.status, 'out-of-balance');
    assert.ok(r.balance.variance < 0);
    assert.equal(r.status, 'out-of-balance');
  });

  test('unverifiable when an item has no amount (unknown kind)', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(11000),
      items: [{ id: 'x', kind: 'mystery_action', amount: null, quantityDelta: 0 }],
    });
    assert.equal(r.balance.status, 'unverifiable');
    assert.deepEqual(r.balance.unknownKinds, ['mystery_action']);
    assert.equal(r.status, 'unverifiable');
  });

  test('a balanced result carries no unknownKinds key at all', () => {
    const r = reconcile({ opening: opening(10), closing: closing(10), items: [] });
    assert.equal('unknownKinds' in r.balance, false);
    assert.equal('crossCheckComputed' in r.balance, false);
  });
});

describe('balance — running-balance path and the cross-check', () => {
  test('uses the running balance when every item carries one and the close is printed', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(11980.02, { printed: true }),
      items: [
        trade('sell', { qty: 50, total: 4990.01, runningBalance: 14990.01, date: '2026-04-10' }),
        trade('buy', { qty: 100, total: 3009.99, runningBalance: 11980.02, date: '2026-04-20' }),
      ],
    });
    assert.equal(r.balance.path, BALANCE_PATH.RUNNING_BALANCE);
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.balance.computed, 11980.02);
    assert.equal(r.balance.crossCheckComputed, 11980.02);
    assert.equal(r.balance.crossCheckVariance, 0);
  });

  test('stays on the amount-sum path when the close is NOT printed, even with running balances', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(11980.02, { printed: false }),
      items: [
        trade('sell', { qty: 50, total: 4990.01, runningBalance: 14990.01, date: '2026-04-10' }),
        trade('buy', { qty: 100, total: 3009.99, runningBalance: 11980.02, date: '2026-04-20' }),
      ],
    });
    assert.equal(r.balance.path, BALANCE_PATH.AMOUNT_SUM);
    assert.equal('crossCheckComputed' in r.balance, false);
  });

  test('flags paths-disagree when the two paths compute different closes', () => {
    // The duplicate whose running balance equals its twin's printed value:
    // invisible to the running-balance path, caught by the sum.
    const r = reconcile({
      opening: opening(10000),
      closing: closing(15000, { printed: true }),
      items: [
        trade('sell', { qty: 100, total: 5000, runningBalance: 15000, date: '2026-04-10' }),
        trade('sell', { qty: 100, total: 5000, runningBalance: 15000, date: '2026-04-10' }),
      ],
    });
    assert.equal(r.balance.status, 'out-of-balance');
    assert.equal(r.balance.path, BALANCE_PATH.PATHS_DISAGREE);
    assert.equal(r.balance.computed, 20000);
    assert.equal('crossCheckComputed' in r.balance, false);
  });

  test('unverifiable wins over the running-balance path, and the cross-check fields still travel', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(11000, { printed: true }),
      items: [
        { id: 'a', kind: 'mystery', amount: null, quantityDelta: 0, runningBalance: 11000, date: '2026-04-10' },
      ],
    });
    assert.equal(r.balance.status, 'unverifiable');
    assert.equal(r.balance.path, BALANCE_PATH.AMOUNT_SUM);
    assert.equal(r.balance.crossCheckComputed, 10000);
    assert.equal(r.balance.crossCheckVariance, -1000);
  });
});

describe('balance — same-day ordering by sequence', () => {
  // The period's last activity date carries two lines. Dates tie; the caller's
  // sequence (an insertion timestamp) must decide which running balance is last.
  const scrambled = () => [
    trade('buy', { qty: 100, total: 3009.99, runningBalance: 3980.02, date: '2026-07-13', sequence: '2026-08-10T20:54:26.200000+00:00' }),
    trade('buy', { qty: 100, total: 3009.99, runningBalance: 6990.01, date: '2026-07-13', sequence: '2026-08-10T20:54:26.100000+00:00' }),
  ];

  test('balanced when same-date items arrive scrambled (sequence tiebreak)', () => {
    const r = reconcile({ opening: opening(10000), closing: closing(3980.02, { printed: true }), items: scrambled() });
    assert.equal(r.balance.path, BALANCE_PATH.RUNNING_BALANCE);
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.balance.computed, 3980.02);
    assert.equal(r.status, 'balanced');
  });

  test('Date objects for date and sequence order identically to strings', () => {
    const items = scrambled().map((it) => ({ ...it, date: new Date(it.date), sequence: new Date(it.sequence) }));
    const r = reconcile({ opening: opening(10000), closing: closing(3980.02, { printed: true }), items });
    assert.equal(r.balance.path, BALANCE_PATH.RUNNING_BALANCE);
    assert.equal(r.balance.status, 'balanced');
  });

  test('items without a sequence keep stable input order', () => {
    const items = scrambled().reverse().map(({ sequence, ...rest }) => rest);
    const r = reconcile({ opening: opening(10000), closing: closing(3980.02, { printed: true }), items });
    assert.equal(r.balance.path, BALANCE_PATH.RUNNING_BALANCE);
    assert.equal(r.balance.status, 'balanced');
  });
});

describe('the multi-fill partial order is NOT a duplicate', () => {
  const fills = () => [
    trade('sell', { qty: 200, total: 5960.01, fee: FEE, date: '2026-04-30' }),
    trade('sell', { qty: 100, total: 2985.00, fee: 0, date: '2026-04-30' }),
    trade('sell', { qty: 200, total: 5970.00, fee: 0, date: '2026-04-30' }),
  ];
  const open = () => opening(10000, [{ symbol: 'MSFT', quantity: 800 }]);
  const close = () => closing(24915.01, { printed: true, positions: [{ symbol: 'MSFT', quantity: 300, price: 29.85 }] });

  test('three fills at one price with one fee line → balanced', () => {
    const r = reconcile({ opening: open(), closing: close(), items: fills() });
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0].symbol, 'MSFT');
    assert.equal(r.positions[0].status, 'balanced');
    assert.equal(r.positions[0].computed, 300);
    assert.equal(r.status, 'balanced');
  });

  test('a phantom fourth fill → out-of-balance on balance AND position', () => {
    const r = reconcile({ opening: open(), closing: close(), items: [...fills(), trade('sell', { qty: 200, total: 5970.00, fee: 0, date: '2026-04-30' })] });
    assert.equal(r.balance.status, 'out-of-balance');
    assert.equal(r.balance.variance, 5970);
    assert.equal(r.positions[0].status, 'out-of-balance');
    assert.equal(r.positions[0].variance, -200);
    assert.equal(r.status, 'out-of-balance');
  });
});

describe('positions', () => {
  test('balanced when opening + Σ quantityDelta = closing for every symbol', () => {
    const r = reconcile({
      opening: opening(10000, [{ symbol: 'MSFT', quantity: 200 }, { symbol: 'AAPL', quantity: 100 }]),
      closing: closing(14480.02, { printed: true, positions: [{ symbol: 'MSFT', quantity: 300 }, { symbol: 'AAPL', quantity: 50 }] }),
      items: [
        trade('buy', { symbol: 'MSFT', qty: 100, total: 3009.99 }),
        trade('sell', { symbol: 'AAPL', qty: 50, total: 7490.01 }),
      ],
    });
    assert.equal(r.positions.length, 2);
    assert.equal(r.positions.find((p) => p.symbol === 'MSFT').status, 'balanced');
    assert.equal(r.positions.find((p) => p.symbol === 'AAPL').status, 'balanced');
    assert.equal(r.status, 'balanced');
  });

  test('a closing position with no supporting items is opened-unexplained', () => {
    const r = reconcile({
      opening: opening(10000, []),
      closing: closing(6990.01, { printed: true, positions: [{ symbol: 'MSFT', quantity: 100 }] }),
      items: [],
    });
    assert.equal(r.positions.length, 1);
    assert.equal(r.positions[0].status, 'opened-unexplained');
    assert.equal(r.status, 'out-of-balance');
  });

  test('a closed + opened pair with matching quantity is a rename, and nets to balanced', () => {
    const r = reconcile({
      opening: opening(10000, [{ symbol: 'PTK', quantity: 500 }]),
      closing: closing(10000, { printed: true, positions: [{ symbol: 'POET', quantity: 500 }] }),
      items: [],
    });
    const ptk = r.positions.find((p) => p.symbol === 'PTK');
    const poet = r.positions.find((p) => p.symbol === 'POET');
    assert.equal(ptk.status, 'renamed');
    assert.equal(ptk.continuedAs, 'POET');
    assert.equal(poet.status, 'renamed');
    assert.equal(poet.continuedFrom, 'PTK');
    assert.equal(r.status, 'balanced');
  });

  test('an item with unknown quantityDelta makes the position unverifiable', () => {
    const r = reconcile({
      opening: opening(10000, [{ symbol: 'MSFT', quantity: 200 }]),
      closing: closing(7000, { printed: true, positions: [{ symbol: 'MSFT', quantity: 200 }] }),
      items: [{ id: 'x', kind: 'mystery_action', symbol: 'MSFT', amount: null, quantityDelta: null }],
    });
    assert.equal(r.positions[0].status, 'unverifiable');
    assert.deepEqual(r.positions[0].unknownKinds, ['mystery_action']);
    assert.equal(r.status, 'unverifiable');
  });
});

describe('fees — soft check', () => {
  test('a fee mismatch is listed but never moves the verdict', () => {
    const r = reconcile({
      opening: opening(10000),
      closing: closing(6995),
      items: [trade('buy', { qty: 100, total: 3005, fee: 5, id: 'fee-1' })],
    });
    assert.equal(r.fees.length, 1);
    assert.equal(r.fees[0].id, 'fee-1');
    assert.equal(r.fees[0].fee, 5);
    assert.equal(r.fees[0].expectedFee, FEE);
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.status, 'balanced');
  });

  test('every fill without the fee is listed, one entry per fill', () => {
    const r = reconcile({
      opening: opening(10000, [{ symbol: 'MSFT', quantity: 500 }]),
      closing: closing(24915.01, { printed: true, positions: [{ symbol: 'MSFT', quantity: 0 }] }),
      items: [
        trade('sell', { qty: 200, total: 5960.01, fee: FEE, date: '2026-04-30' }),
        trade('sell', { qty: 100, total: 2985, fee: 0, date: '2026-04-30' }),
        trade('sell', { qty: 200, total: 5970, fee: 0, date: '2026-04-30' }),
      ],
    });
    assert.equal(r.fees.length, 2);
    assert.equal(r.balance.status, 'balanced');
    assert.equal(r.status, 'balanced');
  });

  test('an item with no expectedFee is never a fee issue, and a null fee against an expected one is', () => {
    const r = reconcile({
      opening: opening(0),
      closing: closing(0),
      items: [
        { id: 'div', kind: 'dividend', amount: 0, quantityDelta: 0, fee: null, expectedFee: null },
        { id: 'nofee', kind: 'buy', symbol: 'X', amount: 0, quantityDelta: 0, fee: null, expectedFee: FEE, date: '2026-01-02' },
      ],
    });
    assert.deepEqual(r.fees, [{ id: 'nofee', kind: 'buy', symbol: 'X', date: '2026-01-02', fee: null, expectedFee: FEE }]);
  });
});

describe('per-account total value', () => {
  test('balanced when expected = actual', () => {
    const r = reconcile({
      opening: opening(10000, [{ symbol: 'MSFT', quantity: 100 }]),
      closing: closing(10000, { printed: true, positions: [{ symbol: 'MSFT', quantity: 100, price: 30 }] }),
      items: [],
    });
    assert.notEqual(r.total, null);
    assert.equal(r.total.status, 'balanced');
    assert.equal(r.total.expected, 13000);
    assert.equal(r.total.actual, 13000);
  });

  test('a variance below materiality is not flagged even though the balance check is', () => {
    const r = reconcile({
      opening: opening(10000, []),
      closing: closing(10001, { printed: true, positions: [] }),
      items: [],
      options: { totalMateriality: 100 },
    });
    assert.equal(r.balance.status, 'out-of-balance');
    assert.equal(r.total.status, 'balanced');
  });

  test('a rename: the old name contributes nothing; the new name has no items, so expected is 0 and materiality absorbs it', () => {
    // Mirrors the source engine exactly. The renamed quantity appears on the
    // ACTUAL side only (closing quantity × price); the expected side is the
    // new name's computed quantity, which no item moved, so 0. Below the
    // materiality gate this is balanced; a large rename would flag the total
    // while the period status (which ignores the total) stays balanced. That
    // asymmetry is inherited, recorded here, and not this utility's to change.
    const r = reconcile({
      opening: opening(0, [{ symbol: 'OLD', quantity: 10 }]),
      closing: closing(0, { printed: true, positions: [{ symbol: 'NEW', quantity: 10, price: 5 }] }),
      items: [],
    });
    assert.equal(r.total.expected, 0);
    assert.equal(r.total.actual, 50);
    assert.equal(r.total.variance, -50);
    assert.equal(r.total.status, 'balanced');
    assert.equal(r.status, 'balanced');
  });
});

describe('input contract', () => {
  test('throws when opening or closing is missing — the caller owns the missing-anchor meaning', () => {
    assert.throws(() => reconcile({ opening: null, closing: closing(1) }), TypeError);
    assert.throws(() => reconcile({ opening: opening(1), closing: undefined }), TypeError);
  });

  test('defaults are the documented tolerances, evidence counts items, no Date leaks into the result', () => {
    assert.deepEqual(DEFAULT_OPTIONS, { balanceTolerance: 0.005, quantityTolerance: 0.0001, totalTolerancePct: 1.0, totalMateriality: 100 });
    const r = reconcile({
      opening: opening(1),
      closing: closing(1, { printed: true }),
      items: [{ id: 'a', kind: 'k', amount: 0, quantityDelta: 0, runningBalance: 1, date: new Date('2026-01-01'), sequence: new Date('2026-01-01T00:00:00Z') }],
    });
    assert.equal(r.evidence.itemCount, 1);
    assert.equal(JSON.stringify(r).includes('T00:00:00'), false);
  });
});
