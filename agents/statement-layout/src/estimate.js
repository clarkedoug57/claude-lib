/**
 * estimate.js — what a run will cost, BEFORE it is spent.
 *
 * Pure arithmetic over the document's shape. Rates are injected (per million
 * tokens); the library carries no price list — the app's cost meter owns that.
 *
 * Assumptions, MEASURED on the R-591 corpus (S250, Opus 5, adaptive thinking;
 * thinking tokens bill as output, which is why the output figures are high):
 *   text page     chars / 2.0 tokens — statement rows are dense with numbers
 *                 and tokenise far worse than prose (a 7.5K-char chequing
 *                 statement was 3.9K input tokens)
 *   image page    3,500 tokens of input per page for a PDF document block
 *                 (a 5-page scan was ~20K per call)
 *   system prompt 2,900 tokens incl. the tool schemas (cache read 2,838),
 *                 sent every call
 *   output        ~100 tokens per proposed line item + 1,500 fixed per
 *                 proposal (50 items → 5.5K; 16 → 3.0K; 1 → 1.3K); a
 *                 transcription round on an image document adds ~120 tokens
 *                 per transcribed row
 *   rounds        the worst case is every round re-sending the document and
 *                 producing a full proposal
 * Against the corpus every worst-case estimate exceeded the metered spend.
 */

export const ESTIMATE_ASSUMPTIONS = Object.freeze({
  charsPerToken: 2.0,
  tokensPerImagePage: 3500,
  systemTokens: 2900,
  feedbackTokensPerRound: 400,
  outputPerItem: 100,
  outputFixed: 1500,
  transcriptionPerRow: 120,
});

/**
 * @param {{ pageCount: number, chars: number, hasTextLayer: boolean, maxCalls?: number,
 *           expectedItems?: number, expectedRows?: number, rates: { input: number, output: number } }} p
 */
export function estimateRun({ pageCount, chars = 0, hasTextLayer, maxCalls = 3, expectedItems = 40, expectedRows = 60, rates }) {
  if (!rates || !Number.isFinite(rates.input) || !Number.isFinite(rates.output)) {
    throw new TypeError('estimateRun: rates { input, output } per million tokens are required');
  }
  const A = ESTIMATE_ASSUMPTIONS;
  const docTokens = hasTextLayer
    ? Math.ceil(chars / A.charsPerToken)
    : pageCount * A.tokensPerImagePage;
  const perCallIn = A.systemTokens + docTokens + A.feedbackTokensPerRound;
  const proposalOut = A.outputFixed + expectedItems * A.outputPerItem;
  const transcriptionOut = hasTextLayer ? 0 : expectedRows * A.transcriptionPerRow;

  // Worst case: every call carries the document and yields a full proposal; an
  // image document spends its first call on the transcription as well.
  const tokensIn = perCallIn * maxCalls;
  const tokensOut = proposalOut * maxCalls + transcriptionOut;
  const usd = (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000;
  return {
    tokensIn,
    tokensOut,
    usd: Math.round(usd * 10000) / 10000,
    perCall: { tokensIn: perCallIn, tokensOut: proposalOut },
    maxCalls,
    assumptions: A,
  };
}
