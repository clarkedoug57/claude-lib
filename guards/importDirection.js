/**
 * importDirection.js — the one rule of the library, made executable.
 *
 * Every package declares its class in its own package.json (claudeLib.class).
 * The class decides which other classes it may import. Anything pointing
 * upward — a utility importing a service, a service importing an agent — is a
 * violation. So is a dependency outside the repository: a bare specifier that
 * is not a `node:` builtin. The library ships with zero dependencies, and the
 * guard is what keeps that true rather than a sentence in a README.
 *
 * Two entry points, deliberately separated so the RULE can be proven against a
 * planted violation without planting a file in the real tree:
 *
 *   scanLibrary(rootDir)          -> { packages }  reads the tree from disk
 *   checkImportDirection(scan)    -> violations[]  pure; the rule itself
 *
 * A package is any directory <kind>/<name>/ (or adapters/store/<name>/) that
 * carries a package.json. Its source is every .js / .mjs under src/. Test
 * files are outside the rule: a test may import whatever it proves.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Folder → the class a package inside it MUST declare. */
export const KIND_DIRS = Object.freeze({
  agents: 'agent',
  services: 'service',
  utilities: 'utility',
  ports: 'port',
  'adapters/store': 'adapter',
});

/** Class → the classes it may import. Upward is anything not listed. */
export const ALLOWED_IMPORTS = Object.freeze({
  agent: Object.freeze(['service', 'utility']),
  service: Object.freeze(['utility', 'port']),
  utility: Object.freeze(['utility']),
  port: Object.freeze([]),
  adapter: Object.freeze(['port', 'utility']),
});

const SOURCE_EXT = new Set(['.js', '.mjs']);

/**
 * Every import specifier in one source file. Covers `import x from 's'`,
 * `import 's'`, `export … from 's'` and `import('s')`. Comment-stripping is
 * deliberately NOT attempted: a specifier mentioned in a comment counts, which
 * errs on the side of a false violation that is trivial to reword, never a
 * missed real one.
 */
export function extractSpecifiers(source) {
  const out = [];
  const re = /(?:^|[^\w$])(?:import|export)\s*(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) out.push(spec);
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Read the library tree. Returns { packages: [{ name, dir, kindDir,
 * declaredClass, expectedClass, files: [{ path, specifiers }] }] }.
 * A package.json without claudeLib.class yields declaredClass null; the check
 * reports it rather than guessing.
 */
export function scanLibrary(rootDir) {
  const packages = [];
  for (const [kindDir, expectedClass] of Object.entries(KIND_DIRS)) {
    const base = path.join(rootDir, ...kindDir.split('/'));
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const manifestPath = path.join(dir, 'package.json');
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const files = walk(path.join(dir, 'src')).map((file) => ({
        path: file,
        specifiers: extractSpecifiers(fs.readFileSync(file, 'utf8')),
      }));
      packages.push({
        name: manifest.name || `${kindDir}/${entry.name}`,
        dir,
        kindDir,
        declaredClass: manifest.claudeLib?.class ?? null,
        expectedClass,
        files,
      });
    }
  }
  return { packages };
}

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

function packageContaining(absFile, packages) {
  const f = norm(absFile);
  return packages.find((pkg) => {
    const d = norm(pkg.dir);
    return f === d || f.startsWith(d + '/');
  }) || null;
}

/**
 * The rule. Pure: takes a scan (from disk or hand-built) and returns every
 * violation as { package, file, specifier, reason }. Empty array = clean.
 */
export function checkImportDirection({ packages }) {
  const violations = [];
  for (const pkg of packages) {
    if (pkg.declaredClass !== pkg.expectedClass) {
      violations.push({
        package: pkg.name,
        file: path.join(pkg.dir, 'package.json'),
        specifier: null,
        reason: `declares class ${JSON.stringify(pkg.declaredClass)} but lives under ${pkg.kindDir}/, which requires "${pkg.expectedClass}"`,
      });
      continue;
    }
    const allowed = ALLOWED_IMPORTS[pkg.declaredClass] || [];
    for (const file of pkg.files) {
      for (const spec of file.specifiers) {
        if (spec.startsWith('node:')) continue;
        const relative = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/');
        if (!relative) {
          violations.push({
            package: pkg.name,
            file: file.path,
            specifier: spec,
            reason: 'external dependency — the library has none; only node: builtins and relative imports are allowed',
          });
          continue;
        }
        const target = path.resolve(path.dirname(file.path), spec);
        const targetPkg = packageContaining(target, packages);
        if (!targetPkg) {
          violations.push({
            package: pkg.name,
            file: file.path,
            specifier: spec,
            reason: 'imports a file outside every package — code that is not in a package has no class',
          });
          continue;
        }
        if (targetPkg === pkg) continue;
        if (!allowed.includes(targetPkg.declaredClass)) {
          violations.push({
            package: pkg.name,
            file: file.path,
            specifier: spec,
            reason: `${pkg.declaredClass} may import [${allowed.join(', ')}] only; ${targetPkg.name} is a ${targetPkg.declaredClass}`,
          });
        }
      }
    }
  }
  return violations;
}

export function formatViolations(violations) {
  return violations
    .map((v) => `  ${v.package}\n    ${v.file}${v.specifier ? `\n    import '${v.specifier}'` : ''}\n    ${v.reason}`)
    .join('\n');
}
