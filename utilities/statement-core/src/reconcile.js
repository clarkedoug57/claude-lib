/**
 * reconcile.js — the period reconciliation gate.
 *
 * class: utility. Zero dependencies. Knows nothing about any application: no
 * account types, no action vocabulary, no fee schedule, no store. Everything
 * app-specific is resolved by the CALLER before this function sees it — the
 * sign of each amount, the quantity delta of each trade, the fee a trade was
 * expected to carry. The utility owns only the arithmetic and the verdict.
 *
 * STRUCTURAL THESIS (carried over from the app it was extracted from)
 *   Every failure class — a duplicate line, a missed line, a misread quantity
 *   or amount — shows up as ONE signal: the chain of items for an account and
 *   period does not reconcile to the period's closing balance. Balance and
 *   positions are reconciled independently; either failing flags the period.
 *   No narrow-key duplicate classifier. The running balance is the truth.
 *
 * INPUT
 *   opening  { balance, positions?: [{ symbol, quantity }] }
 *   closing  { balance, printed?: boolean, positions?: [{ symbol, quantity, price? }] }
 *            `printed` = the closing balance is the issuer's own print, so
 *            the items' running balances may be trusted (the running-balance
 *            path). A balance reconstructed from elsewhere leaves it false.
 *   items    [{ id?, kind?, symbol?, date?, sequence?,
 *               amount,            signed; null = unknown (the caller could not
 *                                  assign a sign to this kind of line)
 *               quantityDelta?,    signed; null = unknown; 0 or absent = none
 *               runningBalance?,   the issuer's printed balance after the line
 *               fee?, expectedFee? both null/absent = no fee check for the line }]
 *            `date` and `sequence` may be strings or Date objects; they order
 *            the items for the running-balance path (date, then sequence).
 *   options  { balanceTolerance, quantityTolerance, totalTolerancePct, totalMateriality }
 *
 * OUTPUT
 *   { balance, positions, fees, total, status, evidence } — see the shape
 *   constants below. Every field is a plain value; nothing is a Date.
 *
 * TWO BALANCE PATHS, ALWAYS CROSS-CHECKED
 *   The amount-sum path always runs: opening + Σ amount. The running-balance
 *   path runs when every item carries a running balance AND the closing is
 *   printed: the last item's running balance, in (date, sequence) order, is
 *   the computed close. When both ran, disagreement between them is itself an
 *   out-of-balance verdict — a duplicate line whose printed running balance
 *   equals its twin's is invisible to the running-balance path alone.
 *
 * ORDERING
 *   Dates are day-granular, so same-day items tie; `sequence` breaks the tie
 *   (a caller passes its insertion timestamp). Items without a sequence
 *   compare equal and keep input order — the stable-sort behaviour every
 *   hand-built fixture relies on.
 */

export const BALANCE_PATH = Object.freeze({
  RUNNING_BALANCE: 'running-balance',
  AMOUNT_SUM: 'amount-sum',
  PATHS_DISAGREE: 'paths-disagree',
});

export const BALANCE_STATUS = Object.freeze({
  BALANCED: 'balanced',
  OUT_OF_BALANCE: 'out-of-balance',
  UNVERIFIABLE: 'unverifiable',
});

export const POSITION_STATUS = Object.freeze({
  BALANCED: 'balanced',
  OUT_OF_BALANCE: 'out-of-balance',
  UNVERIFIABLE: 'unverifiable',
  OPENED_UNEXPLAINED: 'opened-unexplained',
  CLOSED_UNEXPLAINED: 'closed-unexplained',
  RENAMED: 'renamed',
});

export const TOTAL_STATUS = Object.freeze({
  BALANCED: 'balanced',
  OUT_OF_BALANCE: 'out-of-balance',
});

export const RECONCILE_STATUS = Object.freeze({
  BALANCED: 'balanced',
  OUT_OF_BALANCE: 'out-of-balance',
  UNVERIFIABLE: 'unverifiable',
});

export const DEFAULT_OPTIONS = Object.freeze({
  /** Balance variance tolerance — exact to the cent by default. */
  balanceTolerance: 0.005,
  /** Quantity variance tolerance — exact integers. */
  quantityTolerance: 0.0001,
  /** Per-account total-value tolerance, percent. */
  totalTolerancePct: 1.0,
  /** Per-account materiality in currency units — variance below this is noise. */
  totalMateriality: 100,
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const dateKey = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || ''));
const sequenceKey = (v) => (v instanceof Date ? v.toISOString() : String(v || ''));

/**
 * Reconcile one account for one period.
 * @param {{ opening: object, closing: object, items?: object[], options?: object }} input
 */
export function reconcile({ opening, closing, items, options } = {}) {
  if (!opening || !closing) {
    throw new TypeError('reconcile: opening and closing are required — the caller decides what a missing anchor means');
  }
  const opt = { ...DEFAULT_OPTIONS, ...(options || {}) };
  const list = Array.isArray(items) ? items.filter(Boolean) : [];

  const openingBalance = Number(opening.balance) || 0;
  const closingBalance = Number(closing.balance) || 0;

  // ── Balance: amount-sum path (always) ───────────────────────────────────
  const unknownKinds = new Set();
  let amountSum = 0;
  for (const item of list) {
    if (item.amount == null) unknownKinds.add(item.kind);
    else amountSum += item.amount;
  }
  const sumComputed = round2(openingBalance + amountSum);
  const sumVariance = round2(sumComputed - closingBalance);

  // ── Balance: running-balance path (when trustworthy) ────────────────────
  let printedComputed = null;
  let printedVariance = null;
  const allCarryRunning = list.length > 0 && list.every((item) => item.runningBalance != null);
  if (allCarryRunning && closing.printed === true) {
    const ordered = [...list].sort(
      (a, b) => dateKey(a.date).localeCompare(dateKey(b.date))
        || sequenceKey(a.sequence).localeCompare(sequenceKey(b.sequence)),
    );
    const last = ordered[ordered.length - 1];
    printedComputed = round2(Number(last.runningBalance) || 0);
    printedVariance = round2(printedComputed - closingBalance);
  }

  let balanceStatus;
  let balancePath;
  let balanceComputed;
  let balanceVariance;
  if (unknownKinds.size > 0) {
    balanceStatus = BALANCE_STATUS.UNVERIFIABLE;
    balancePath = BALANCE_PATH.AMOUNT_SUM;
    balanceComputed = sumComputed;
    balanceVariance = sumVariance;
  } else if (printedComputed !== null) {
    const pathsAgree = Math.abs(printedComputed - sumComputed) <= opt.balanceTolerance;
    if (!pathsAgree) {
      balanceStatus = BALANCE_STATUS.OUT_OF_BALANCE;
      balancePath = BALANCE_PATH.PATHS_DISAGREE;
      balanceComputed = sumComputed;
      balanceVariance = sumVariance;
    } else {
      balanceStatus = Math.abs(printedVariance) <= opt.balanceTolerance
        ? BALANCE_STATUS.BALANCED
        : BALANCE_STATUS.OUT_OF_BALANCE;
      balancePath = BALANCE_PATH.RUNNING_BALANCE;
      balanceComputed = printedComputed;
      balanceVariance = printedVariance;
    }
  } else {
    balanceStatus = Math.abs(sumVariance) <= opt.balanceTolerance
      ? BALANCE_STATUS.BALANCED
      : BALANCE_STATUS.OUT_OF_BALANCE;
    balancePath = BALANCE_PATH.AMOUNT_SUM;
    balanceComputed = sumComputed;
    balanceVariance = sumVariance;
  }

  const balance = {
    opening: round2(openingBalance),
    closing: round2(closingBalance),
    computed: balanceComputed,
    variance: balanceVariance,
    status: balanceStatus,
    path: balancePath,
  };
  if (unknownKinds.size > 0) balance.unknownKinds = [...unknownKinds];
  if (printedComputed !== null && balancePath !== BALANCE_PATH.PATHS_DISAGREE) {
    balance.crossCheckComputed = sumComputed;
    balance.crossCheckVariance = sumVariance;
  }

  // ── Positions ───────────────────────────────────────────────────────────
  const openQty = new Map();
  for (const p of opening.positions || []) {
    if (!p || !p.symbol) continue;
    openQty.set(p.symbol, Number(p.quantity) || 0);
  }
  const closeQty = new Map();
  const closePrice = new Map();
  for (const p of closing.positions || []) {
    if (!p || !p.symbol) continue;
    closeQty.set(p.symbol, Number(p.quantity) || 0);
    closePrice.set(p.symbol, Number(p.price) || 0);
  }

  const positions = [];
  for (const symbol of new Set([...openQty.keys(), ...closeQty.keys()])) {
    const openingQuantity = openQty.get(symbol) || 0;
    const closingQuantity = closeQty.get(symbol) || 0;
    const supporting = list.filter((item) => item.symbol === symbol && item.quantityDelta !== 0);
    const unknown = new Set();
    let delta = 0;
    for (const item of supporting) {
      if (item.quantityDelta == null) unknown.add(item.kind);
      else delta += item.quantityDelta;
    }
    const computed = round4(openingQuantity + delta);
    const variance = round4(computed - closingQuantity);

    let status;
    if (unknown.size > 0) status = POSITION_STATUS.UNVERIFIABLE;
    else if (Math.abs(variance) <= opt.quantityTolerance) status = POSITION_STATUS.BALANCED;
    else if (openingQuantity === 0 && closingQuantity > 0 && supporting.length === 0) status = POSITION_STATUS.OPENED_UNEXPLAINED;
    else if (closingQuantity === 0 && openingQuantity > 0 && supporting.length === 0) status = POSITION_STATUS.CLOSED_UNEXPLAINED;
    else status = POSITION_STATUS.OUT_OF_BALANCE;

    const entry = { symbol, opening: openingQuantity, closing: closingQuantity, computed, variance, status };
    if (unknown.size > 0) entry.unknownKinds = [...unknown];
    positions.push(entry);
  }

  // A closed position and an opened one with matching quantity, and no items
  // for either, is a relabel by the issuer, not a real change. Pair them so
  // the total nets to zero.
  for (const closed of positions) {
    if (closed.status !== POSITION_STATUS.CLOSED_UNEXPLAINED) continue;
    const opened = positions.find((n) =>
      n.status === POSITION_STATUS.OPENED_UNEXPLAINED
      && Math.abs((n.closing || 0) - (closed.opening || 0)) < opt.quantityTolerance);
    if (!opened) continue;
    closed.status = POSITION_STATUS.RENAMED;
    closed.continuedAs = opened.symbol;
    opened.status = POSITION_STATUS.RENAMED;
    opened.continuedFrom = closed.symbol;
  }

  // ── Fees (soft) ─────────────────────────────────────────────────────────
  // A fee mismatch is surfaced, never a period verdict: an issuer may bill one
  // fee across several fills. The caller decides what to make of the list.
  const fees = [];
  for (const item of list) {
    if (item.expectedFee == null) continue;
    const actual = item.fee == null ? null : Number(item.fee);
    if (actual == null || Math.abs(actual - item.expectedFee) > 0.005) {
      fees.push({
        id: item.id,
        kind: item.kind,
        symbol: item.symbol,
        date: item.date,
        fee: actual,
        expectedFee: item.expectedFee,
      });
    }
  }

  // ── Per-account total value ─────────────────────────────────────────────
  // expected = Σ computed quantity × closing price + computed balance
  // actual   = Σ closing quantity  × closing price + closing balance
  // Native currency. Flags only when BOTH the materiality and percent gates
  // are exceeded.
  let total = null;
  if (closePrice.size > 0 || balanceComputed != null) {
    let expectedSecurities = 0;
    let actualSecurities = 0;
    for (const p of positions) {
      if (p.status === POSITION_STATUS.RENAMED && p.continuedAs) continue; // the old name contributes 0
      const price = closePrice.get(p.symbol) || 0;
      expectedSecurities += (p.computed || 0) * price;
      actualSecurities += (p.closing || 0) * price;
    }
    const expected = round2(expectedSecurities + balanceComputed);
    const actual = round2(actualSecurities + closingBalance);
    const variance = round2(expected - actual);
    const denominator = Math.max(Math.abs(expected), Math.abs(actual));
    const variancePct = denominator < 0.01 ? 0 : (variance / denominator) * 100;
    const material = Math.abs(variance) > opt.totalMateriality;
    const overPct = Math.abs(variancePct) > opt.totalTolerancePct;
    total = {
      expected,
      actual,
      variance,
      variancePct: round4(variancePct),
      status: material && overPct ? TOTAL_STATUS.OUT_OF_BALANCE : TOTAL_STATUS.BALANCED,
    };
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  const positionOutOfBalance = positions.some((p) =>
    p.status === POSITION_STATUS.OUT_OF_BALANCE
    || p.status === POSITION_STATUS.OPENED_UNEXPLAINED
    || p.status === POSITION_STATUS.CLOSED_UNEXPLAINED);
  const positionUnverifiable = positions.some((p) => p.status === POSITION_STATUS.UNVERIFIABLE);
  const balanceOutOfBalance = balance.status === BALANCE_STATUS.OUT_OF_BALANCE;
  const balanceUnverifiable = balance.status === BALANCE_STATUS.UNVERIFIABLE;

  let status;
  if (balanceOutOfBalance || positionOutOfBalance) status = RECONCILE_STATUS.OUT_OF_BALANCE;
  else if (balanceUnverifiable || positionUnverifiable) status = RECONCILE_STATUS.UNVERIFIABLE;
  else status = RECONCILE_STATUS.BALANCED;

  return {
    balance,
    positions,
    fees,
    total,
    status,
    evidence: { itemCount: list.length },
  };
}
