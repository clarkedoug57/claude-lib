/**
 * The import-direction guard, proven two ways:
 *   1. against the REAL tree — must be clean, and must have found packages
 *      (a guard that scans nothing passes vacuously, which is not a pass);
 *   2. against PLANTED violations — the rule must fail on an upward import,
 *      on an external dependency, on a mis-declared class and on an import
 *      that escapes every package. A guard that has never been seen to fail
 *      has not been proven to guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanLibrary,
  checkImportDirection,
  extractSpecifiers,
  formatViolations,
  KIND_DIRS,
  ALLOWED_IMPORTS,
} from '../guards/importDirection.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('real tree: every package declares its class and nothing imports upward', () => {
  const scan = scanLibrary(ROOT);
  assert.ok(scan.packages.length >= 1, 'the scan found no packages — the guard would pass vacuously');
  for (const pkg of scan.packages) {
    assert.ok(pkg.files.length >= 1, `${pkg.name} has no source files under src/`);
  }
  const violations = checkImportDirection(scan);
  assert.equal(violations.length, 0, `import-direction violations:\n${formatViolations(violations)}`);
});

test('real tree: every kind folder maps to a class that has an allowed-imports entry', () => {
  for (const cls of Object.values(KIND_DIRS)) {
    assert.ok(Array.isArray(ALLOWED_IMPORTS[cls]), `no ALLOWED_IMPORTS entry for class ${cls}`);
  }
});

/** A hand-built scan: two packages, no disk. */
function synthetic({ utilitySpecs = [], serviceSpecs = [], utilityClass = 'utility' } = {}) {
  const utilDir = path.join(ROOT, 'utilities', 'fake-util');
  const svcDir = path.join(ROOT, 'services', 'fake-svc');
  return {
    packages: [
      {
        name: 'fake-util', dir: utilDir, kindDir: 'utilities',
        declaredClass: utilityClass, expectedClass: 'utility',
        files: [{ path: path.join(utilDir, 'src', 'index.js'), specifiers: utilitySpecs }],
      },
      {
        name: 'fake-svc', dir: svcDir, kindDir: 'services',
        declaredClass: 'service', expectedClass: 'service',
        files: [{ path: path.join(svcDir, 'src', 'index.js'), specifiers: serviceSpecs }],
      },
    ],
  };
}

test('planted: a utility importing a service is an upward import and FAILS', () => {
  const v = checkImportDirection(synthetic({ utilitySpecs: ['../../../services/fake-svc/src/index.js'] }));
  assert.equal(v.length, 1);
  assert.equal(v[0].package, 'fake-util');
  assert.match(v[0].reason, /utility may import \[utility\] only; fake-svc is a service/);
});

test('planted: a service importing a utility is downward and passes', () => {
  const v = checkImportDirection(synthetic({ serviceSpecs: ['../../../utilities/fake-util/src/index.js'] }));
  assert.equal(v.length, 0, formatViolations(v));
});

test('planted: an external dependency FAILS; a node: builtin does not', () => {
  const bad = checkImportDirection(synthetic({ utilitySpecs: ['lodash'] }));
  assert.equal(bad.length, 1);
  assert.match(bad[0].reason, /external dependency/);
  const ok = checkImportDirection(synthetic({ utilitySpecs: ['node:fs', './helper.js'] }));
  assert.equal(ok.length, 0, formatViolations(ok));
});

test('planted: a class that disagrees with its folder FAILS', () => {
  const v = checkImportDirection(synthetic({ utilityClass: 'service' }));
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /declares class "service" but lives under utilities\//);
});

test('planted: an import that escapes every package FAILS', () => {
  const v = checkImportDirection(synthetic({ utilitySpecs: ['../../../guards/importDirection.js'] }));
  assert.equal(v.length, 1);
  assert.match(v[0].reason, /outside every package/);
});

test('extractSpecifiers sees every import form', () => {
  const src = `
    import a from './a.js';
    import { b } from "../b.js";
    import './side.js';
    export { c } from './c.js';
    export * from './d.js';
    const e = await import('./e.js');
    const notAnImport = "from './f.js'";
  `;
  assert.deepEqual(extractSpecifiers(src), ['./a.js', '../b.js', './side.js', './c.js', './d.js', './e.js']);
});
