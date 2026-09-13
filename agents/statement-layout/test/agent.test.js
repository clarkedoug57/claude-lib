/**
 * statement-layout — the replay suite. ZERO live calls.
 *
 * A scripted ModelPort returns recorded replies in order and records what it
 * was asked. The proposals are synthetic translations of the R-591 corpus
 * shapes: a chequing statement with running balances, a credit card with a
 * summary block and no running balance, an image-only card that must be
 * transcribed first, and a web-page capture that is not a statement.
 *
 * What is proven:
 *   - a right proposal is accepted in one call, and the port saw the frozen
 *     system prompt, the three strict tools and the document as text rows;
 *   - a WRONG proposal (a misread digit) is REJECTED, the failure names the
 *     section and the variance, the feedback reaches the model verbatim, and
 *     the corrected second proposal is accepted — two calls, both metered;
 *   - three wrong proposals exhaust the cap with the last failures returned;
 *   - a proposal that drops a dated row is rejected for coverage; one that
 *     invents an account number is rejected for identity; one whose printed
 *     anchor is not on the page is rejected;
 *   - an image document travels as a document block, its transcription
 *     becomes the verifier's source, and the proposal is checked against it;
 *   - a verdict stops the loop with the reason; a turn with no tool call
 *     stops as no-output; the spend cap stops BEFORE the next call.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  runLayoutAgent, RUN_OUTCOME, FAILURE, SYSTEM_PROMPT, TOOL_NAMES, verifyProposal, estimateRun, ESTIMATE_ASSUMPTIONS,
} from '../src/index.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const CHEQUING_PAGES = [
  [
    'Example Bank   your no fee chequing account',
    'account number: 01-23456   JANE EXAMPLE and JOHN EXAMPLE',
    'statement period: July 30 to August 30, 2026',
    'trans. date  eff. date  transaction  funds out  funds in  balance',
    'Jul 30  Jul 30  BALANCE FORWARD      1,965.84',
    'Aug 01  Aug 01  PAYROLL DEPOSIT    5,250.01  7,215.85',
    'Aug 05  Aug 06  BILL PAYMENT HYDRO  157.37    7,058.48',
  ],
  [
    'Aug 20  Aug 20  TRANSFER OUT  5,500.00    1,558.48',
    'Aug 30  Aug 30  CLOSING BALANCE      1,558.48',
    'total funds out 5,657.37   total funds in 5,250.01',
    'Questions? Call 1 888 723 8881',
  ],
];

function chequingProposal() {
  return {
    issuer: 'Example Bank',
    documentType: 'chequing',
    currency: 'CAD',
    period: { start: '2026-07-30', end: '2026-08-30' },
    sections: [{
      identity: { accountNumber: '01-23456', holders: ['JANE EXAMPLE', 'JOHN EXAMPLE'], label: 'no fee chequing account' },
      period: null,
      opening: { balance: 1965.84, printed: true },
      closing: { balance: 1558.48, printed: true },
      items: [
        { date: '2026-08-01', effectiveDate: '2026-08-01', description: 'PAYROLL DEPOSIT', amount: 5250.01, runningBalance: 7215.85, page: 1, sequence: 0, category: null },
        { date: '2026-08-05', effectiveDate: '2026-08-06', description: 'BILL PAYMENT HYDRO', amount: -157.37, runningBalance: 7058.48, page: 1, sequence: 1, category: null },
        { date: '2026-08-20', effectiveDate: '2026-08-20', description: 'TRANSFER OUT', amount: -5500, runningBalance: 1558.48, page: 2, sequence: 2, category: null },
      ],
      positions: null,
    }],
    ignored: [
      { page: 1, text: 'Jul 30  Jul 30  BALANCE FORWARD      1,965.84', reason: 'opening balance line, not a transaction' },
      { page: 2, text: 'Aug 30  Aug 30  CLOSING BALANCE      1,558.48', reason: 'closing balance line' },
    ],
  };
}

const CARD_TRANSCRIPTION = [
  [
    'Some Card Company  World Elite Mastercard',
    'Statement period: Aug 9 to Sep 8, 2026',
    'Account number 5555 1234 5678 4321',
    'Previous Balance $2,397.33   Purchases $7,933.58   Payments -$5,963.51   Statement Balance $4,367.40',
  ],
  [
    '12/08  13/08  GROCER ELORA ON  150.00',
    '20/08  21/08  HARDWARE FERGUS ON  7,783.58',
    '31/08  31/08  PAYMENT CIBC  -5,963.51',
  ],
];

function cardProposal() {
  return {
    issuer: 'Some Card Company',
    documentType: 'credit-card',
    currency: 'CAD',
    period: { start: '2026-08-09', end: '2026-09-08' },
    sections: [{
      identity: { accountNumber: '5555 1234 5678 4321', holders: [], label: 'World Elite Mastercard' },
      period: null,
      opening: { balance: 2397.33, printed: true },
      closing: { balance: 4367.40, printed: true },
      items: [
        { date: '2026-08-12', effectiveDate: '2026-08-13', description: 'GROCER ELORA ON', amount: 150, runningBalance: null, page: 2, sequence: 0, category: null },
        { date: '2026-08-20', effectiveDate: '2026-08-21', description: 'HARDWARE FERGUS ON', amount: 7783.58, runningBalance: null, page: 2, sequence: 1, category: null },
        { date: '2026-08-31', effectiveDate: '2026-08-31', description: 'PAYMENT CIBC', amount: -5963.51, runningBalance: null, page: 2, sequence: 2, category: null },
      ],
      positions: null,
    }],
    ignored: [
      { page: 1, text: 'Previous Balance $2,397.33   Purchases $7,933.58   Payments -$5,963.51   Statement Balance $4,367.40', reason: 'summary block' },
      { page: 1, text: 'Statement period: Aug 9 to Sep 8, 2026', reason: 'period line' },
    ],
  };
}

const usage = (n = 1) => ({ inputTokens: 1000 * n, outputTokens: 500 * n, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 * n });

/** A scripted port: replies in order, records every request. */
function scriptedPort(replies) {
  const requests = [];
  return {
    requests,
    propose: async (req) => {
      // Snapshot: the agent hands over its LIVE message array (an adapter
      // serialises it at once, so that is fine in production); a recorder
      // must copy it or every request would show the final history.
      requests.push({ ...req, messages: [...req.messages] });
      if (replies.length === 0) throw new Error('scripted port ran out of replies');
      const r = replies.shift();
      return typeof r === 'function' ? r(req) : r;
    },
  };
}

const propose = (input, id = 'tu-1') => ({ stopReason: 'tool_use', toolUses: [{ id, name: TOOL_NAMES.PROPOSE, input }], text: null, usage: usage() });

// ── Text documents ──────────────────────────────────────────────────────────

describe('text document: a right proposal', () => {
  test('is accepted in one call, and the port saw the frozen prompt, the strict tools and the rows', async () => {
    const port = scriptedPort([propose(chequingProposal())]);
    const r = await runLayoutAgent({ source: { fileName: 'chq.pdf', pages: CHEQUING_PAGES }, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.PROPOSED);
    assert.equal(r.usage.calls, 1);
    assert.equal(r.usage.costUsd, 0.01);
    assert.equal(r.verification.ok, true);
    assert.equal(r.verification.sourceKind, 'text');

    const req = port.requests[0];
    assert.equal(req.system, SYSTEM_PROMPT);
    assert.deepEqual(req.tools.map((t) => t.name).sort(), [TOOL_NAMES.PROPOSE, TOOL_NAMES.TRANSCRIBE, TOOL_NAMES.VERDICT].sort());
    assert.ok(req.tools.every((t) => t.strict === true));
    const proposeTool = req.tools.find((t) => t.name === TOOL_NAMES.PROPOSE);
    assert.equal(proposeTool.inputSchema.additionalProperties, false);
    // No strict-unsupported constraint keyword reaches the wire on ANY tool
    // (the API 400s on `minimum` for an integer — seen live, R-591 S250).
    const offending = (node, found = []) => {
      if (Array.isArray(node)) node.forEach((n) => offending(n, found));
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern'].includes(k)) found.push(k); offending(v, found); }
      return found;
    };
    for (const t of req.tools) assert.deepEqual(offending(t.inputSchema), [], `${t.name} carries a strict-unsupported keyword`);
    assert.equal(req.messages.length, 1);
    assert.equal(req.messages[0].role, 'user');
    assert.ok(req.messages[0].content[0].text.includes('=== page 2 ==='));
    assert.ok(req.messages[0].content[0].text.includes('BILL PAYMENT HYDRO'));
  });
});

describe('text document: a WRONG proposal is rejected and corrected', () => {
  test('a misread digit fails the gate; the feedback names section and variance; the second proposal passes', async () => {
    const wrong = chequingProposal();
    wrong.sections[0].items[1].amount = -157.73; // digits transposed
    const port = scriptedPort([propose(wrong, 'tu-1'), propose(chequingProposal(), 'tu-2')]);
    const r = await runLayoutAgent({ source: { fileName: 'chq.pdf', pages: CHEQUING_PAGES }, model: port });

    assert.equal(r.outcome, RUN_OUTCOME.PROPOSED);
    assert.equal(r.usage.calls, 2);
    assert.equal(r.usage.costUsd, 0.02);
    assert.equal(r.rounds.length, 2);
    const first = r.rounds[0].failures;
    assert.ok(first.some((f) => f.code === FAILURE.OUT_OF_BALANCE), JSON.stringify(first));
    const oob = first.find((f) => f.code === FAILURE.OUT_OF_BALANCE);
    assert.equal(oob.section, 0);
    assert.equal(oob.variance, -0.36);
    assert.deepEqual(r.rounds[1].failures, []);

    // The correction round carried the assistant echo, the tool result and the feedback verbatim.
    const second = port.requests[1];
    assert.equal(second.messages.length, 4);
    assert.equal(second.messages[1].role, 'assistant');
    assert.equal(second.messages[1].content[0].type, 'toolUse');
    assert.equal(second.messages[1].content[0].id, 'tu-1');
    assert.equal(second.messages[2].content[0].type, 'toolResult');
    assert.equal(second.messages[2].content[0].toolUseId, 'tu-1');
    assert.match(second.messages[3].content[0].text, /\[out-of-balance\] section 0 \(01-23456\)/);
    assert.match(second.messages[3].content[0].text, /variance -0\.36/);
  });

  test('a port-supplied echo travels on the assistant turn, verbatim, beside the neutral blocks', async () => {
    const wrong = chequingProposal();
    wrong.sections[0].closing.balance = 1;
    const opaque = [{ type: 'thinking', thinking: '', signature: 'sig-abc' }, { type: 'tool_use', id: 'tu-1', name: TOOL_NAMES.PROPOSE, input: wrong }];
    const port = scriptedPort([{ ...propose(wrong, 'tu-1'), echo: opaque }, propose(chequingProposal(), 'tu-2')]);
    const r = await runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.PROPOSED);
    const echoed = port.requests[1].messages[1];
    assert.equal(echoed.role, 'assistant');
    assert.strictEqual(echoed.echo, opaque);
    assert.equal(echoed.content[0].type, 'toolUse');
    // A reply without echo leaves the key off entirely.
    assert.equal('echo' in port.requests[1].messages[0], false);
  });

  test('a running balance that disagrees with the amount sum is caught even when the closing matches', async () => {
    const wrong = chequingProposal();
    // The last running balance equals the closing (the running-balance path
    // would pass alone) but a line's amount is wrong — the cross-check fires.
    wrong.sections[0].items[0].amount = 5250.10;
    const port = scriptedPort([propose(wrong)]);
    const r = await runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: port, options: { maxCalls: 1 } });
    assert.equal(r.outcome, RUN_OUTCOME.EXHAUSTED);
    const oob = r.failures.find((f) => f.code === FAILURE.OUT_OF_BALANCE);
    assert.ok(oob);
    assert.equal(oob.path, 'paths-disagree');
  });

  test('three wrong proposals exhaust the cap; the last failures come back', async () => {
    const wrong = chequingProposal();
    wrong.sections[0].closing.balance = 1558.84;
    const port = scriptedPort([propose(wrong, 'a'), propose(wrong, 'b'), propose(wrong, 'c')]);
    const r = await runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.EXHAUSTED);
    assert.equal(r.usage.calls, 3);
    assert.equal(r.statement.sections[0].closing.balance, 1558.84);
    assert.ok(r.failures.some((f) => f.code === FAILURE.OUT_OF_BALANCE));
    assert.ok(r.failures.some((f) => f.code === FAILURE.ANCHOR_NOT_IN_SOURCE), 'a closing figure not on the page is also an identity failure');
    assert.match(r.reason, /within 3 call/);
  });
});

describe('the verifier alone — each check proven to fail', () => {
  const src = { kind: 'text', pages: CHEQUING_PAGES };

  test('schema: a malformed proposal returns schema failures and nothing else', () => {
    const bad = chequingProposal();
    delete bad.sections[0].items[0].page;
    const v = verifyProposal(bad, src);
    assert.equal(v.ok, false);
    assert.ok(v.failures.every((f) => f.code === FAILURE.SCHEMA));
    assert.match(v.failures[0].path, /items\/0\/page/);
  });

  test('coverage: dropping a dated row (and its amount) is caught — even when the arithmetic is made to balance', () => {
    const p = chequingProposal();
    // Drop HYDRO and absorb it into TRANSFER OUT so the sum still balances.
    p.sections[0].items.splice(1, 1);
    p.sections[0].items[1].amount = -5657.37;
    p.sections[0].items[1].runningBalance = 1558.48;
    p.sections[0].items[1].sequence = 1;
    const v = verifyProposal(p, src);
    assert.equal(v.ok, false);
    const un = v.failures.filter((f) => f.code === FAILURE.UNCOVERED_ROW);
    assert.equal(un.length, 1, JSON.stringify(v.failures));
    assert.equal(un[0].page, 1);
    assert.match(un[0].text, /BILL PAYMENT HYDRO/);
  });

  test('coverage: an ignored row with a reason explains a dated amount row', () => {
    const p = chequingProposal();
    p.ignored.push({ page: 2, text: 'total funds out 5,657.37', reason: 'totals line' });
    const v = verifyProposal(p, src);
    assert.equal(v.ok, true, JSON.stringify(v.failures));
  });

  test('coverage: a page with amounts and no items and nothing ignored is a failure', () => {
    const p = chequingProposal();
    p.sections[0].items = p.sections[0].items.filter((i) => i.page !== 2).concat([
      // keep the sum balanced by moving the transfer to page 1
      { ...p.sections[0].items[2], page: 1 },
    ]);
    p.ignored = p.ignored.filter((i) => i.page !== 2);
    const v = verifyProposal(p, src);
    assert.ok(v.failures.some((f) => f.code === FAILURE.EMPTY_PAGE_WITH_AMOUNTS && f.page === 2), JSON.stringify(v.failures));
  });

  test('identity: an account number not on the page is rejected', () => {
    const p = chequingProposal();
    p.sections[0].identity.accountNumber = '99-99999';
    const v = verifyProposal(p, src);
    assert.ok(v.failures.some((f) => f.code === FAILURE.ACCOUNT_NOT_IN_SOURCE));
  });

  test('identity: a period end in no printed form is rejected', () => {
    const p = chequingProposal();
    p.period.end = '2026-09-30';
    const v = verifyProposal(p, src);
    assert.ok(v.failures.some((f) => f.code === FAILURE.PERIOD_NOT_IN_SOURCE));
  });

  test('identity: a printed anchor that is not a figure on the page is rejected; an unprinted one is not checked', () => {
    const p = chequingProposal();
    p.sections[0].opening.balance = 1965.48;
    p.sections[0].items[0].runningBalance = 7215.49; // keep running path consistent
    p.sections[0].items[1].runningBalance = 7058.12;
    p.sections[0].items[2].runningBalance = 1558.12;
    p.sections[0].closing.balance = 1558.12;
    let v = verifyProposal(p, src);
    assert.ok(v.failures.some((f) => f.code === FAILURE.ANCHOR_NOT_IN_SOURCE && f.anchor === 'opening'));
    assert.ok(v.failures.some((f) => f.code === FAILURE.ANCHOR_NOT_IN_SOURCE && f.anchor === 'closing'));
    p.sections[0].opening.printed = false;
    p.sections[0].closing.printed = false;
    v = verifyProposal(p, src);
    assert.ok(!v.failures.some((f) => f.code === FAILURE.ANCHOR_NOT_IN_SOURCE));
  });

  test('no source at all is a failure, never a pass', () => {
    const v = verifyProposal(chequingProposal(), {});
    assert.ok(v.failures.some((f) => f.code === FAILURE.NO_SOURCE));
  });
});

// ── Image documents ─────────────────────────────────────────────────────────

describe('image document: transcribe, then propose', () => {
  const source = { fileName: 'card.pdf', pdf: { base64: 'JVBERi0xLjQK', mediaType: 'application/pdf' }, pageCount: 2 };

  test('the document travels as a document block; the transcription becomes the verifier source', async () => {
    const port = scriptedPort([
      { stopReason: 'tool_use', toolUses: [{ id: 't1', name: TOOL_NAMES.TRANSCRIBE, input: { pages: CARD_TRANSCRIPTION } }], text: null, usage: usage() },
      propose(cardProposal(), 't2'),
    ]);
    const r = await runLayoutAgent({ source, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.PROPOSED);
    assert.equal(r.usage.calls, 2);
    assert.equal(r.verification.sourceKind, 'transcription');
    assert.deepEqual(r.transcription, CARD_TRANSCRIPTION);
    assert.equal(r.rounds[0].transcribedRows, 7);

    const first = port.requests[0].messages[0];
    assert.equal(first.content[0].type, 'document');
    assert.equal(first.content[0].mediaType, 'application/pdf');
    assert.equal(first.content[0].base64, 'JVBERi0xLjQK');
    assert.match(first.content[1].text, /Transcribe every page first/);
    // The second call carries the transcription's tool result.
    assert.equal(port.requests[1].messages[2].content[0].type, 'toolResult');
    assert.match(port.requests[1].messages[2].content[0].text, /7 rows/);
  });

  test('transcription and proposal in the same turn are both processed', async () => {
    const port = scriptedPort([{
      stopReason: 'tool_use',
      toolUses: [
        { id: 't1', name: TOOL_NAMES.TRANSCRIBE, input: { pages: CARD_TRANSCRIPTION } },
        { id: 't2', name: TOOL_NAMES.PROPOSE, input: cardProposal() },
      ],
      text: null, usage: usage(),
    }]);
    const r = await runLayoutAgent({ source, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.PROPOSED);
    assert.equal(r.usage.calls, 1);
  });

  test('a proposal with no transcription for an image document fails as no-source and is fed back', async () => {
    const port = scriptedPort([propose(cardProposal(), 't1'), { stopReason: 'end_turn', toolUses: [], text: 'sorry', usage: usage() }]);
    const r = await runLayoutAgent({ source, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.NO_OUTPUT);
    assert.ok(r.rounds[0].failures.some((f) => f.code === FAILURE.NO_SOURCE));
    assert.match(port.requests[1].messages[3].content[0].text, /transcribe the pages first/);
  });

  test('a misread digit in a ~70-line card is caught by the purchases arithmetic', async () => {
    const wrong = cardProposal();
    wrong.sections[0].items[1].amount = 7783.85;
    const port = scriptedPort([{
      stopReason: 'tool_use',
      toolUses: [
        { id: 't1', name: TOOL_NAMES.TRANSCRIBE, input: { pages: CARD_TRANSCRIPTION } },
        { id: 't2', name: TOOL_NAMES.PROPOSE, input: wrong },
      ],
      text: null, usage: usage(),
    }]);
    const r = await runLayoutAgent({ source, model: port, options: { maxCalls: 1 } });
    assert.equal(r.outcome, RUN_OUTCOME.EXHAUSTED);
    const oob = r.failures.find((f) => f.code === FAILURE.OUT_OF_BALANCE);
    assert.equal(oob.variance, 0.27);
  });
});

// ── Verdicts, silence, budget ───────────────────────────────────────────────

describe('stops', () => {
  test('a verdict stops the loop with the reason quoted', async () => {
    const port = scriptedPort([{ stopReason: 'tool_use', toolUses: [{ id: 'v', name: TOOL_NAMES.VERDICT, input: { kind: 'not-a-statement', reason: 'Last Statement Balance: Not applicable · No Transactions' } }], text: null, usage: usage() }]);
    const r = await runLayoutAgent({ source: { pdf: { base64: 'x' }, pageCount: 2 }, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.VERDICT);
    assert.equal(r.verdict.kind, 'not-a-statement');
    assert.match(r.verdict.reason, /Not applicable/);
    assert.equal(r.statement, null);
    assert.equal(r.usage.calls, 1);
  });

  test('a turn with no tool call is no-output, with the text kept', async () => {
    const port = scriptedPort([{ stopReason: 'end_turn', toolUses: [], text: 'I think this is a statement.', usage: usage() }]);
    const r = await runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: port });
    assert.equal(r.outcome, RUN_OUTCOME.NO_OUTPUT);
    assert.equal(r.text, 'I think this is a statement.');
  });

  test('the spend cap stops BEFORE the next call, and every call is summed', async () => {
    const wrong = chequingProposal();
    wrong.sections[0].closing.balance = 1;
    const port = scriptedPort([
      { ...propose(wrong, 'a'), usage: { ...usage(), costUsd: 0.6 } },
      { ...propose(wrong, 'b'), usage: { ...usage(), costUsd: 0.5 } },
      propose(chequingProposal(), 'c'),
    ]);
    const r = await runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: port, options: { maxCalls: 5, maxUsd: 1.0 } });
    assert.equal(r.outcome, RUN_OUTCOME.BUDGET);
    assert.equal(r.usage.calls, 2);
    assert.equal(r.usage.costUsd, 1.1);
    assert.equal(port.requests.length, 2, 'the third reply was never requested');
    assert.match(r.reason, /before call 3/);
  });

  test('a port without propose() is refused', async () => {
    await assert.rejects(runLayoutAgent({ source: { pages: CHEQUING_PAGES }, model: {} }), TypeError);
  });
});

describe('estimate', () => {
  test('a text document costs less than an image document of the same length, and both are cents', () => {
    const rates = { input: 5, output: 25 };
    const text = estimateRun({ pageCount: 3, chars: 6000, hasTextLayer: true, rates });
    const image = estimateRun({ pageCount: 5, chars: 0, hasTextLayer: false, expectedItems: 70, expectedRows: 120, rates });
    assert.ok(text.usd < image.usd);
    assert.ok(text.usd > 0 && text.usd < 1, `text ${text.usd}`);
    assert.ok(image.usd > 0 && image.usd < 2, `image ${image.usd}`);
    assert.equal(text.maxCalls, 3);
    const A = ESTIMATE_ASSUMPTIONS;
    assert.equal(text.tokensIn, 3 * (A.systemTokens + Math.ceil(6000 / A.charsPerToken) + A.feedbackTokensPerRound));
  });

  test('the worst case exceeds the R-591 corpus measurements (the estimate errs high, never low)', () => {
    const rates = { input: 5, output: 25 };
    // 5-page scan, 76 items: metered $1.1366 over 2 calls.
    assert.ok(estimateRun({ pageCount: 5, chars: 0, hasTextLayer: false, expectedItems: 80, expectedRows: 120, rates }).usd > 1.1366);
    // 5-page chequing text, 7.5K chars, 50 items: metered $0.1597 in 1 call.
    assert.ok(estimateRun({ pageCount: 5, chars: 7500, hasTextLayer: true, expectedItems: 50, rates }).usd > 0.1597);
    // 3-page line of credit text, 6.1K chars, 16 items: metered $0.0901.
    assert.ok(estimateRun({ pageCount: 3, chars: 6100, hasTextLayer: true, expectedItems: 16, rates }).usd > 0.0901);
  });

  test('refuses without rates', () => {
    assert.throws(() => estimateRun({ pageCount: 1, chars: 100, hasTextLayer: true }), TypeError);
  });
});
