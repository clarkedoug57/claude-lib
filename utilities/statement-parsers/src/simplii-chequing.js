/**
 * simplii-chequing.js — Simplii Financial no-fee chequing account (form 7010CA).
 * The reader is simplii-ledger.js; this module is the fingerprint and the labels.
 */

import { parseSimpliiLedger } from './simplii-ledger.js';

export const ID = 'simplii-chequing';

export const FINGERPRINT = Object.freeze({
  id: ID,
  version: '7010CA-2024/09',
  label: 'Simplii Financial no fee chequing account statement',
  must: Object.freeze(['your no fee chequing account', '7010CA-']),
  // The chequing footer mentions "Personal Lines of Credit"; the form code,
  // not the phrase, separates the two ledgers.
  mustNot: Object.freeze(['7010PLC']),
});

export function parse(pages) {
  return parseSimpliiLedger(pages, {
    layout: ID,
    issuer: 'Simplii Financial',
    documentType: 'chequing',
    labelPattern: /^your no fee chequing account/i,
  });
}
