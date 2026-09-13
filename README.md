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

## Running the tests

```
npm test
```

Node's built-in runner (`node --test`), no dependencies. Every `test/**/*.js` under the root and under each package runs.

## Versioning

Tags are the versions apps pin (`v0.1.0`). A change to any package bumps the root version; the consuming app's pin is a deliberate reconciliation, never a silent bump.
