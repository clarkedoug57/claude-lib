/**
 * fixtures.js — the staged-fixture format and the redaction rule.
 *
 * class: utility. Zero dependencies.
 *
 * A staged fixture is the SPECIFICATION for a parser that does not exist yet:
 * the canonical Statement a human accepted, the raw rows it was read from, and
 * enough provenance to trust it. Because fixtures live in a public repository
 * by decision (R-591 D3), redaction is applied BY CONSTRUCTION — stageFixture
 * refuses to build a fixture whose raw rows or statement still carry an
 * unmasked account number or a name on the supplied list.
 *
 * WHAT REDACTION KEEPS, AND WHY
 *   amounts and dates    kept verbatim — they are what the fixture PROVES
 *                        (the gate balances them to the cent)
 *   merchant strings     kept — a parser is tested on real merchant shapes
 *   account numbers      masked to the last four digits ("····4567"); every
 *                        run of 5+ digits (with optional dashes/spaces) is
 *                        treated as a candidate account number
 *   card numbers         the "4525 XXXX XXXX 1234" form keeps its shape with
 *                        the digit groups masked
 *   holder names         replaced with HOLDER-n, in order of first appearance
 *   listed names         any name the caller lists (counterparties in
 *                        e-transfers, employers) → PERSON-n
 *   Interac lines        the free text after SEND / REQ MONEY / RECEIVED FROM /
 *                        E-TRANSFER TO is replaced with PERSON-n even when the
 *                        caller listed no names — those are always people
 *
 * NEGATIVE FIXTURE
 *   A document that is NOT a statement is a fixture too: it records the verdict
 *   and the reason quoted from the page, so a later change cannot start
 *   inventing a Statement for it.
 */

export const FIXTURE_KIND = Object.freeze({
  STATEMENT: 'statement',
  VERDICT: 'verdict',
});

export const FIXTURE_FORMAT_VERSION = 1;

// 5+ digits, dashes allowed inside, NEVER spaces — a run that may cross a space
// merges two adjacent numbers on a row ("0194  250.00" became "····4250.00" on
// the R-591 corpus and destroyed the amount). Never part of a decimal or a
// comma-grouped figure either: amounts are what a fixture proves.
const LONG_DIGIT_RUN = /(?<![\d.,])\d(?:[\d-]{3,}\d)(?![\d.,])/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CARD_GROUPS = /\b(\d{4})[ \-](?:[\dX]{4}[ \-]){2}(\d{4})\b/gi;
// Every Interac verb seen on the R-591 corpus: SEND / RECEIVE / REQ MONEY,
// plus the longer forms. What follows the verb is a person.
const INTERAC = /((?:E-?TRANSFER|E-?TFR|INTERAC)[^A-Za-z0-9]*(?:SEND|SENT|TO|REQ MONEY|REQUEST|RECEIVE|RECEIVED|RECEIVED FROM|FROM|DEPOSIT)\s+)(.+)$/i;
// A bank's own transfer line names the OTHER account: "HP355 TFR-FR 392HF3J".
// The reference after TFR-FR / TFR-TO is an account identifier — mask it.
const TRANSFER_REF = /(\bTFR-?(?:FR|TO)\s*)([A-Z0-9]{5,})/gi;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name or phrase as a whitespace-insensitive, case-insensitive pattern ("DOUG  SMITH" matches "Doug Smith"). */
function phrasePattern(s) {
  return new RegExp(String(s).trim().split(/\s+/).map(escapeRegExp).join('\\s+'), 'gi');
}

function maskDigits(text) {
  return String(text)
    .replace(CARD_GROUPS, (m, first, last) => `${first} XXXX XXXX ${last}`)
    .replace(LONG_DIGIT_RUN, (run) => {
      if (ISO_DATE.test(run)) return run; // a date is not an identifier
      const digits = run.replace(/\D/g, '');
      if (digits.length < 5) return run;
      return `····${digits.slice(-4)}`;
    })
    .replace(TRANSFER_REF, (m, lead, ref) => (ref === 'REDACTED' || ref.startsWith('····') ? m : `${lead}····${ref.slice(-3)}`));
}

/**
 * Build the name→placeholder map. Holders first (HOLDER-n), then listed names
 * (PERSON-n); longer names first so "Jane Smith" wins over "Jane".
 */
/**
 * holders → HOLDER-n; names → PERSON-n; redact → REDACTED (an address line, a
 * postal code, a spelling of a holder's name the page prints differently).
 * Longest first so "Jane Smith" wins over "Jane"; whitespace-insensitive.
 */
function buildNameMap(holders = [], names = [], redact = []) {
  const map = [];
  holders.filter(Boolean).forEach((h, i) => map.push({ name: String(h), placeholder: `HOLDER-${i + 1}` }));
  names.filter(Boolean).forEach((n, i) => map.push({ name: String(n), placeholder: `PERSON-${i + 1}` }));
  redact.filter(Boolean).forEach((r) => map.push({ name: String(r), placeholder: 'REDACTED' }));
  return map.sort((a, b) => b.name.length - a.name.length);
}

function replaceNames(text, nameMap) {
  let out = String(text);
  for (const { name, placeholder } of nameMap) {
    out = out.replace(phrasePattern(name), placeholder);
  }
  out = out.replace(INTERAC, (m, lead, rest) => {
    // Already a placeholder, or a bank reference like "* * * J5b"? Leave it.
    const r = rest.trim();
    if (/^(PERSON|HOLDER)-\d+/.test(r) || /^(PERSON-X|REDACTED)\b/.test(r) || /^[*\s]/.test(r)) return m;
    return `${lead}PERSON-X`;
  });
  return out;
}

export function redactText(text, { holders = [], names = [], redact = [] } = {}) {
  return maskDigits(replaceNames(text, buildNameMap(holders, names, redact)));
}

/**
 * Redact a canonical Statement in place of a copy: identity numbers masked,
 * holders replaced, descriptions and ignored text redacted. Amounts, dates,
 * balances and sequence are untouched.
 */
export function redactStatement(statement, { names = [], redact = [] } = {}) {
  const copy = JSON.parse(JSON.stringify(statement));
  const allHolders = copy.sections.flatMap((s) => s.identity?.holders || []).filter((h) => !/^HOLDER-\d+$/.test(h));
  const opts = { holders: allHolders, names, redact };
  for (const section of copy.sections) {
    section.identity.accountNumber = redactText(section.identity.accountNumber, opts);
    // Holders become HOLDER-n by POSITION (a re-redaction of an already-staged
    // fixture keeps its placeholders; a first pass maps each printed name).
    section.identity.holders = (section.identity.holders || []).map((h) => (/^HOLDER-\d+$/.test(h) ? h : redactText(h, opts)));
    if (section.identity.label) section.identity.label = redactText(section.identity.label, opts);
    for (const item of section.items) item.description = redactText(item.description, opts);
  }
  for (const row of copy.ignored || []) row.text = redactText(row.text, opts);
  return copy;
}

/** Redact raw rows (per page) with the same rule. */
export function redactRows(pages, { holders = [], names = [], redact = [] } = {}) {
  return (pages || []).map((rows) => (rows || []).map((r) => redactText(r, { holders, names, redact })));
}

/**
 * Residual check: anything that still looks like an account number, a listed
 * name or phrase, an unmasked transfer reference, or a bare Interac
 * counterparty in the text is a leak. Returns the offending strings (empty =
 * clean).
 */
export function findResiduals(text, { holders = [], names = [], redact = [] } = {}) {
  const hits = [];
  const body = String(text);
  for (const m of body.matchAll(LONG_DIGIT_RUN)) {
    if (ISO_DATE.test(m[0])) continue;
    if (m[0].replace(/\D/g, '').length >= 5) hits.push(m[0]);
  }
  for (const n of [...holders, ...names, ...redact].filter(Boolean)) {
    const p = phrasePattern(n);
    p.lastIndex = 0;
    if (new RegExp(p.source, 'i').test(body)) hits.push(String(n));
  }
  for (const m of body.matchAll(TRANSFER_REF)) hits.push(m[0]);
  const interac = INTERAC.exec(body);
  if (interac) {
    const r = interac[2].trim();
    if (!(/^(PERSON|HOLDER)-\d+/.test(r) || /^(PERSON-X|REDACTED)\b/.test(r) || /^[*\s]/.test(r))) hits.push(interac[0]);
  }
  return hits;
}

/**
 * The fixture id: <issuer-slug>/<document-type-slug>[/<version>].
 */
export function fixtureId({ issuer, documentType, version = null }) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const parts = [slug(issuer), slug(documentType)];
  if (version) parts.push(slug(version));
  return parts.join('/');
}

/**
 * Stage a statement fixture. Redacts by construction and REFUSES a fixture that
 * still leaks: the public repository never receives an unmasked number.
 */
export function stageFixture({ statement, rawPages, notes = '', provenance = {}, names = [], redact = [], version = null }) {
  if (!statement || !Array.isArray(statement.sections)) throw new TypeError('stageFixture: a canonical statement is required');
  const holders = statement.sections.flatMap((s) => s.identity?.holders || []).filter((h) => !/^HOLDER-\d+$/.test(h));
  const redacted = redactStatement(statement, { names, redact });
  const rows = redactRows(rawPages, { holders, names, redact });

  const leaks = [];
  const scan = (label, text) => { for (const r of findResiduals(text, { holders, names, redact })) leaks.push(`${label}: ${r}`); };
  for (const [pi, page] of rows.entries()) page.forEach((r, ri) => scan(`raw p${pi + 1} r${ri}`, r));
  for (const [si, s] of redacted.sections.entries()) {
    scan(`section ${si} accountNumber`, s.identity.accountNumber);
    s.items.forEach((it, ii) => scan(`section ${si} item ${ii}`, it.description));
  }
  (redacted.ignored || []).forEach((row, i) => scan(`ignored ${i}`, row.text));
  // Notes are a human's words and are never rewritten — so they are the one
  // field that can still carry a name or a number. Scan, and refuse.
  scan('notes', notes);
  if (leaks.length > 0) {
    throw new Error(`stageFixture: redaction left residuals — refuse to stage:\n  ${leaks.join('\n  ')}`);
  }

  return {
    formatVersion: FIXTURE_FORMAT_VERSION,
    kind: FIXTURE_KIND.STATEMENT,
    id: fixtureId({ issuer: statement.issuer, documentType: statement.documentType, version }),
    statement: redacted,
    raw: { pages: rows },
    notes,
    provenance: { stagedAt: provenance.stagedAt || null, sourceHash: provenance.sourceHash || null, pageCount: rows.length, hasTextLayer: provenance.hasTextLayer ?? null, ...provenance },
  };
}

/**
 * Stage a NEGATIVE fixture: a document the agent refused, with the verdict and
 * the reason quoted from the page. `rawPages` may be empty for an image-only
 * document — the reason text is then the only record, and that is the point.
 */
export function stageVerdictFixture({ id, verdict, rawPages = [], notes = '', provenance = {}, names = [], redact = [] }) {
  if (!verdict || !verdict.kind || !verdict.reason) throw new TypeError('stageVerdictFixture: verdict { kind, reason } is required');
  const rows = redactRows(rawPages, { names, redact });
  return {
    formatVersion: FIXTURE_FORMAT_VERSION,
    kind: FIXTURE_KIND.VERDICT,
    id,
    verdict: { kind: verdict.kind, reason: redactText(verdict.reason, { names, redact }) },
    raw: { pages: rows },
    notes,
    provenance: { stagedAt: provenance.stagedAt || null, sourceHash: provenance.sourceHash || null, pageCount: rows.length, hasTextLayer: provenance.hasTextLayer ?? null, ...provenance },
  };
}
