/**
 * prompt.js — the agent's goal and tools, as the model sees them.
 *
 * The system prompt is a FROZEN constant: byte-identical on every call so a
 * caching adapter can reuse it. Nothing volatile goes here — the document and
 * the round's feedback travel in the messages.
 *
 * The tools are declared in a neutral shape { name, description, inputSchema,
 * strict } — the adapter maps them to its API. The proposal tool's schema IS
 * the canonical model (statement-model), so a proposal cannot have a shape
 * the verifier cannot check.
 */

import { statementToolSchema, toStrictToolSchema } from '../../../utilities/statement-model/src/index.js';

export const VERDICT_KIND = Object.freeze({
  NOT_A_STATEMENT: 'not-a-statement',
  UNSUPPORTED: 'unsupported',
  ENCRYPTED: 'encrypted',
  UNREADABLE: 'unreadable',
});

export const TOOL_NAMES = Object.freeze({
  PROPOSE: 'propose_statement',
  TRANSCRIBE: 'transcribe_pages',
  VERDICT: 'verdict',
});

export const SYSTEM_PROMPT = [
  'You read financial statements — bank accounts, credit cards, lines of credit, investment accounts — and turn ONE document into a canonical Statement, or say why you cannot.',
  '',
  'THE MODEL',
  'A Statement has an issuer, a documentType, a currency, a period {start, end}, one AccountSection per account the document reports, and an ignored[] list.',
  'An AccountSection has identity {accountNumber, holders, label}, an opening balance and a closing balance exactly as the issuer prints them (printed: true when the figure is on the page), items[] in print order, and positions (null unless it is an investment account).',
  'A LineItem has date (the date the issuer\'s period totals use — usually the transaction date, not the posting date), effectiveDate (the other date, or null), description as printed, a SIGNED amount, runningBalance (the printed balance after the line, or null), page (1-based), sequence (0-based print order within the section), category (the issuer\'s own hint, or null).',
  '',
  'THE SIGN CONVENTION — this is what is checked',
  'amount is signed so that: opening + sum(amount of every item) = closing, to the cent, for each section.',
  'For a deposit account (chequing, savings): money in is positive, money out is negative.',
  'For an account tracked as an amount OWED (credit card, line of credit shown as a balance owing): a purchase or interest charge is positive, a payment or credit is negative. If the issuer prints the balance with a trailing minus or CR to mean the opposite of its usual sense, convert: a line of credit printed as "16,485.19-" (owed) is opening −16485.19 when the account is tracked as a balance, and funds in then reduce what is owed by adding to a negative number. Choose ONE convention per section and make the equation hold.',
  '',
  'COVERAGE — every dated row with an amount must be an item or be listed in ignored[] with a reason',
  'Summary blocks, totals, interest-rate tables, tear-off payment slips, spend reports, marketing text and page footers are not items: list each such dated-amount row in ignored[] with its page and reason. A row you did not use and did not list is a failure.',
  'Never invent a line. Never drop a line to make the equation balance. If the equation does not balance, re-read the page: a misread digit, a missed line, a wrong sign, a wrong date on a boundary line.',
  '',
  'IDENTITY — the account number and the period end must appear on the page; every printed opening and closing balance must be a figure on the page.',
  '',
  'PROCESS',
  'If the document arrives as extracted text rows, call propose_statement directly.',
  'If the document arrives as pages (an image or a PDF with no text layer), FIRST call transcribe_pages with every row of every page, verbatim, in reading order — dates, descriptions and amounts exactly as printed. THEN call propose_statement. The transcription is your source; the proposal is checked against it and its arithmetic against the printed totals.',
  'If the document is not a statement at all — a web page capture, a letter, a form, a receipt, an empty account page saying there is nothing to report — call verdict with kind "not-a-statement" and quote the words on the page that say so. If it is a statement of a kind you cannot read, call verdict with "unsupported". If it is encrypted or unreadable, say which.',
  'If a previous proposal was returned to you with failures, fix exactly what the failures name and propose again. Do not restate the whole reasoning; the tool call is the answer.',
  'Call one tool per turn, except that transcribe_pages and propose_statement may be called in the same turn for an image document.',
].join('\n');

export function tools() {
  return [
    {
      name: TOOL_NAMES.PROPOSE,
      description: 'Propose the canonical Statement for this document. Every section must balance: opening + sum(items.amount) = closing. Every dated row with an amount is an item or is in ignored[].',
      inputSchema: statementToolSchema(),
      strict: true,
    },
    {
      name: TOOL_NAMES.TRANSCRIBE,
      description: 'For a document supplied as pages/images: the rows of every page, verbatim, in reading order. pages[i] is page i+1; each row is one printed line with its cells separated by two spaces.',
      inputSchema: toStrictToolSchema({
        type: 'object',
        additionalProperties: false,
        required: ['pages'],
        properties: {
          pages: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      }),
      strict: true,
    },
    {
      name: TOOL_NAMES.VERDICT,
      description: 'This document cannot be turned into a Statement. Say why, quoting the page.',
      inputSchema: toStrictToolSchema({
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'reason'],
        properties: {
          kind: { type: 'string', enum: Object.values(VERDICT_KIND) },
          reason: { type: 'string' },
        },
      }),
      strict: true,
    },
  ];
}

/** The first user turn: the document, in one of two forms, plus the ask. */
export function documentMessage(source) {
  const blocks = [];
  if (Array.isArray(source.pages) && source.pages.length > 0) {
    const text = source.pages
      .map((rows, i) => `=== page ${i + 1} ===\n${(rows || []).join('\n')}`)
      .join('\n\n');
    blocks.push({ type: 'text', text: `Document "${source.fileName || 'document'}", ${source.pages.length} page(s), extracted text rows follow. Each row is one printed line; cells are separated by two spaces.\n\n${text}` });
    blocks.push({ type: 'text', text: 'Propose the Statement, or give a verdict.' });
  } else if (source.pdf && source.pdf.base64) {
    blocks.push({ type: 'document', mediaType: source.pdf.mediaType || 'application/pdf', base64: source.pdf.base64, title: source.fileName || 'document' });
    blocks.push({ type: 'text', text: `Document "${source.fileName || 'document'}", ${source.pageCount || '?'} page(s), supplied as pages with no text layer. Transcribe every page first (transcribe_pages), then propose the Statement — or give a verdict.` });
  } else {
    throw new TypeError('documentMessage: source needs pages[] (text rows) or pdf { base64 }');
  }
  return { role: 'user', content: blocks };
}

export function feedbackMessage(failures, describe) {
  return {
    role: 'user',
    content: [{ type: 'text', text: `The proposal was checked and failed. Fix exactly these and propose again:\n${describe(failures)}` }],
  };
}
