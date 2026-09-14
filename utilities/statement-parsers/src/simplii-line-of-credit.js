/**
 * simplii-line-of-credit.js — Simplii Financial personal line of credit (form 7010PLC).
 * The reader is simplii-ledger.js; this module is the fingerprint and the labels.
 * Balances print with a trailing minus when owed; the ledger rule handles it.
 */

import { parseSimpliiLedger } from './simplii-ledger.js';

export const ID = 'simplii-line-of-credit';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: '7010PLC-2024/09',
  label: 'Simplii Financial personal line of credit statement',
  must: Object.freeze(['your personal line of credit', '7010PLC']),
  mustNot: Object.freeze(['7010CA-']),
});

export function parse(pages) {
  return parseSimpliiLedger(pages, {
    layout: ID,
    issuer: 'Simplii Financial',
    documentType: 'line-of-credit',
    labelPattern: /^your personal line of credit/i,
  });
}
