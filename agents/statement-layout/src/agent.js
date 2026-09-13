/**
 * agent.js — the layout agent's loop.
 *
 * class: agent. A model chooses the next step; the code owns the stop, the
 * budget and the verifier. The model is reached ONLY through `model`, a
 * ModelPort the caller supplies:
 *
 *   model.propose({ system, messages, tools, maxTokens })
 *     → { toolUses: [{ name, input }], text, stopReason,
 *         usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }, model }
 *
 * messages use a neutral block shape: { role, content: [ {type:'text', text}
 * | {type:'document', mediaType, base64, title} | {type:'toolUse', id, name,
 * input} | {type:'toolResult', toolUseId, text} ] }. The adapter maps it.
 *
 * GOAL   propose a Statement whose every section balances, list every unused
 *        row, or say plainly that this is not a statement.
 * TOOLS  propose_statement (strict; schema = the model), transcribe_pages,
 *        verdict. Reading the pages, checking the gate and staging a fixture
 *        are CODE, not model tools: the document goes in the first message,
 *        the verifier runs after every proposal, staging is the caller's.
 * STOP   verified proposal → 'proposed'; a verdict → 'verdict'; call cap →
 *        'exhausted' (the last failures are returned); spend cap → 'budget';
 *        a turn with no tool call → 'no-output'.
 * BUDGET every call's usage is summed; the loop checks the cap BEFORE the
 *        next call, never after the money is gone.
 *
 * The library's tests replay recorded proposals — right and wrong — through
 * this loop with a scripted port and zero live calls.
 */

import { SYSTEM_PROMPT, TOOL_NAMES, tools, documentMessage, feedbackMessage } from './prompt.js';
import { verifyProposal, describeFailures } from './verifier.js';

export const RUN_OUTCOME = Object.freeze({
  PROPOSED: 'proposed',
  VERDICT: 'verdict',
  EXHAUSTED: 'exhausted',
  BUDGET: 'budget',
  NO_OUTPUT: 'no-output',
});

export const DEFAULT_RUN_OPTIONS = Object.freeze({
  maxCalls: 3,
  maxUsd: 2.0,
  maxTokens: 32000,
});

function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

function addUsage(total, u = {}) {
  total.calls += 1;
  total.inputTokens += Number(u.inputTokens) || 0;
  total.outputTokens += Number(u.outputTokens) || 0;
  total.cacheReadTokens += Number(u.cacheReadTokens) || 0;
  total.cacheWriteTokens += Number(u.cacheWriteTokens) || 0;
  total.costUsd = Math.round((total.costUsd + (Number(u.costUsd) || 0)) * 1e6) / 1e6;
  return total;
}

/**
 * Run the agent over one document.
 * @param {{ source: { fileName?, pages?: string[][], pdf?: { base64, mediaType }, pageCount? },
 *           model: { propose: Function }, options?: object }} p
 */
export async function runLayoutAgent({ source, model, options = {} }) {
  if (!model || typeof model.propose !== 'function') throw new TypeError('runLayoutAgent: a ModelPort with propose() is required');
  const opt = { ...DEFAULT_RUN_OPTIONS, ...options };
  const usage = emptyUsage();
  const rounds = [];
  const messages = [documentMessage(source)];
  const toolDefs = tools();

  // For a text document the verifier's source is the extracted rows. For an
  // image document it is the model's transcription, once one arrives.
  const textSource = Array.isArray(source.pages) && source.pages.length > 0 ? { kind: 'text', pages: source.pages } : null;
  let transcription = null;

  let lastFailures = [];
  let lastStatement = null;

  for (let call = 1; call <= opt.maxCalls; call += 1) {
    if (usage.costUsd >= opt.maxUsd) {
      return finish(RUN_OUTCOME.BUDGET, { reason: `spend ${usage.costUsd} reached the cap ${opt.maxUsd} before call ${call}` });
    }

    const reply = await model.propose({ system: SYSTEM_PROMPT, messages, tools: toolDefs, maxTokens: opt.maxTokens });
    addUsage(usage, reply.usage);
    const round = { call, stopReason: reply.stopReason || null, toolNames: (reply.toolUses || []).map((t) => t.name), usage: reply.usage || null, failures: [], text: reply.text || null };
    rounds.push(round);

    const toolUses = Array.isArray(reply.toolUses) ? reply.toolUses : [];
    if (toolUses.length === 0) {
      return finish(RUN_OUTCOME.NO_OUTPUT, { reason: 'the model returned no tool call', text: reply.text || null });
    }

    // Echo the assistant turn so a correction round has the history. When the
    // port supplies `echo` (its raw assistant content — thinking blocks and
    // signatures included), it travels alongside so the adapter can pass the
    // turn back byte-identical; an API that binds thinking to the turn
    // rejects an edited one. The neutral toolUse blocks stay for any port
    // that has no such need.
    messages.push({
      role: 'assistant',
      content: toolUses.map((t, i) => ({ type: 'toolUse', id: t.id || `call-${call}-${i}`, name: t.name, input: t.input })),
      ...(reply.echo ? { echo: reply.echo } : {}),
    });

    const verdict = toolUses.find((t) => t.name === TOOL_NAMES.VERDICT);
    if (verdict) {
      return finish(RUN_OUTCOME.VERDICT, { verdict: { kind: verdict.input?.kind, reason: verdict.input?.reason } });
    }

    const transcribe = toolUses.find((t) => t.name === TOOL_NAMES.TRANSCRIBE);
    if (transcribe && Array.isArray(transcribe.input?.pages)) {
      transcription = transcribe.input.pages.map((rows) => (Array.isArray(rows) ? rows.map(String) : []));
      round.transcribedRows = transcription.reduce((n, p) => n + p.length, 0);
    }

    const proposal = toolUses.find((t) => t.name === TOOL_NAMES.PROPOSE);
    const toolResults = [];
    if (transcribe) toolResults.push({ type: 'toolResult', toolUseId: transcribe.id || `call-${call}-${toolUses.indexOf(transcribe)}`, text: `Transcription received: ${round.transcribedRows || 0} rows. Now propose the Statement.` });

    if (proposal) {
      lastStatement = proposal.input;
      const verifierSource = textSource || (transcription ? { kind: 'transcription', pages: transcription } : {});
      const verification = verifyProposal(lastStatement, verifierSource);
      round.failures = verification.failures;
      round.sourceKind = verification.sourceKind;
      if (verification.ok) {
        return finish(RUN_OUTCOME.PROPOSED, { statement: lastStatement, verification });
      }
      lastFailures = verification.failures;
      toolResults.push({ type: 'toolResult', toolUseId: proposal.id || `call-${call}-${toolUses.indexOf(proposal)}`, text: `Checked: ${verification.failures.length} failure(s).` });
      messages.push({ role: 'user', content: toolResults });
      messages.push(feedbackMessage(verification.failures, describeFailures));
      continue;
    }

    // A transcription alone: acknowledge and let the next call propose.
    messages.push({ role: 'user', content: toolResults });
  }

  return finish(RUN_OUTCOME.EXHAUSTED, { reason: `no verified proposal within ${opt.maxCalls} call(s)`, statement: lastStatement, failures: lastFailures });

  function finish(outcome, extra) {
    return {
      outcome,
      statement: extra.statement ?? null,
      verification: extra.verification ?? null,
      failures: extra.failures ?? (extra.verification ? extra.verification.failures : []),
      verdict: extra.verdict ?? null,
      transcription,
      reason: extra.reason ?? null,
      text: extra.text ?? null,
      rounds,
      usage,
      options: opt,
    };
  }
}
