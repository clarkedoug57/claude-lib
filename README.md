# claude-lib

The shared library for the Claude framework projects. One repository, one version number, pinned by each app as a git dependency (`github:clarkedoug57/claude-lib#v<version>`). It holds code and synthetic fixtures only: no state, no secrets, no data.

## The three kinds, and the one rule

Every package declares its **class** in its own `package.json` under `claudeLib.class`. The class decides what a package may import:

| Class | Lives in | May import |
|---|---|---|
| `agent` — a model chooses the next step | `agents/` | services, utilities |
| `service` — owns I/O or state behind a contract, declares its ports | `services/` | utilities, ports |
| `utility` — pure, proven by fixtures, knows nothing about any app | `utilities/` | utilities |
| `port` — an interface only, no code that runs | `ports/` | nothing |
| `adapter` — implements a port for one store | `adapters/store/` | ports, utilities |

Imports that point upward fail the test suite. So does any dependency outside this repository (a bare import that is not a `node:` builtin). The guard is `guards/importDirection.js`; its proof is `test/import-direction.test.js`, which runs it over the real tree and over a planted violation.

## Packages

- `utilities/statement-core` — the period reconciliation gate: opening balance plus the signed items must equal the closing balance, per-position quantities likewise. Extracted from Portfolio Command Center (R-589). Sign normalisation is the caller's job; the library never sees an app's transaction vocabulary.
- `utilities/statement-model` — the canonical Statement / AccountSection / LineItem as a JSON Schema, a validator over it (no dependencies, by rule), and the strict-tool schema generated from it (R-591).
- `utilities/statement-detect` — layout detection over extracted text: a fingerprint registry (must / mustNot / version), the no-text-layer signal (100 characters per page), and the 1 / 0 / 2+ rule. An app registers the fingerprints for the parsers it owns (R-591).
- `utilities/statement-fixtures` — the staged-fixture format, the redaction rule (holders, listed names, Interac counterparties, account numbers, transfer references; amounts and merchant strings kept), the residual scan that refuses a leak, and the negative fixture for a document that is not a statement (R-591).
- `agents/statement-layout` — the layout agent: given a document no fingerprint recognised, propose a Statement whose every section balances, list every unused row with a reason, or say plainly that this is not a statement. The model sits behind a `ModelPort` the app supplies; the verifier (schema, arithmetic, coverage, identity) is code, never the model. Tests replay recorded right AND wrong proposals with zero live calls (R-591).
- `ports/statement-store` — what a statement lifecycle asks an app for, in domain terms: find a statement by its document hash, find the prior records for an account and period, capture and supersede the items they own, record the statement, insert its items with their owner, write the closing anchor, reconcile, restore. Which methods are load-bearing and which degrade is declared here (R-592).
- `services/statement-lifecycle` — the lifecycle every statement type shares, in one fixed order: dedup by document (a match means re-import, never skip), capture judgment before the wipe, statement = gospel across every source, one record per account and period reused when held, items carrying ownership, the closing anchor, reconciliation. A load-bearing failure restores the capture and is reported, never thrown. `bundleFromStatement` projects a canonical Statement onto the bundle the lifecycle takes; an unresolved account is refused, never guessed (R-592).
- `adapters/store/memory` — an in-memory StatementStore: the lifecycle's own proof and any app's test double. Every staged fixture imports through it on every `npm test` — chequing, credit card, line of credit — and re-imports without duplicating, which is the proof that the lifecycle belongs to no app and no statement type (R-592).

## The lifecycle, and who owns what

An app implements `StatementStore` once, against its own tables. From then on every parser it adds — hand-written or staged from a layout-agent fixture — gets the identical dedup, supersession, ownership, anchor and reconciliation, because the ORDER lives in the service and the app's store cannot be called out of it. The service never reads an item, never derives a period, never names a table. What is investment-specific (positions, symbol resolution, holdings) stays inside the app's `insertItems`; what is universal is not the app's to re-implement.

## Fixtures

`fixtures/<issuer>/<document-type>.json` are staged by a human decision through an app's Statement lab, redacted by construction, and re-proven on every `npm test`: each validates against the model, balances per section through the gate, passes the verifier against its own raw rows, and carries no redaction residual. A fixture is the specification for a parser that does not exist yet. `fixtures/verdicts/` holds the documents the agent must keep refusing.

## Running the tests

```
npm test
```

Node's built-in runner (`node --test`), no dependencies. Every `test/**/*.js` under the root and under each package runs.

## Versioning

Tags are the versions apps pin (`v0.1.0`, `v0.2.0`, `v0.3.0`). A change to any package bumps the root version; the consuming app's pin is a deliberate reconciliation, never a silent bump.
