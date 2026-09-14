/**
 * bundle.js — the one projection from a canonical Statement to an ImportBundle.
 *
 * A canonical Statement (utilities/statement-model) knows the issuer's account
 * identity as printed; a store knows the app's account key. The caller
 * supplies the resolver. An identity the resolver cannot place is an ERROR,
 * never a guess — the lifecycle must not write a statement into the wrong
 * account because a number looked close.
 *
 * Items are passed through untouched: the canonical LineItem IS the item
 * shape a store built for canonical statements receives. An app whose store
 * wants a different shape builds its own bundle (that is what a parser-
 * specific adapter does); this projection is for the canonical path.
 */

/**
 * @param {object} statement   a canonical Statement (validated by the caller)
 * @param {{ document: { hash: string, name?: string|null },
 *           resolveAccountKey: (identity: object, section: object, statement: object) => string|null|undefined }} args
 */
export function bundleFromStatement(statement, { document, resolveAccountKey } = {}) {
  if (!statement || !Array.isArray(statement.sections)) {
    throw new TypeError('bundleFromStatement: a canonical Statement with sections is required');
  }
  if (!document || typeof document.hash !== 'string' || document.hash.length === 0) {
    throw new TypeError('bundleFromStatement: document.hash is required');
  }
  if (typeof resolveAccountKey !== 'function') {
    throw new TypeError('bundleFromStatement: resolveAccountKey is required — the service never guesses an account');
  }

  const unresolved = [];
  const sections = statement.sections.map((section) => {
    const key = resolveAccountKey(section.identity, section, statement);
    if (typeof key !== 'string' || key.length === 0) {
      unresolved.push(section.identity?.accountNumber ?? '(no account number)');
    }
    const period = section.period || statement.period;
    return {
      accountKey: key,
      period: { start: period.start, end: period.end },
      currency: statement.currency ?? null,
      opening: section.opening ? { balance: section.opening.balance, printed: section.opening.printed === true } : null,
      closing: section.closing ? { balance: section.closing.balance, printed: section.closing.printed === true } : null,
      items: section.items || [],
      extras: {
        identity: section.identity,
        positions: section.positions ?? null,
      },
    };
  });

  if (unresolved.length > 0) {
    throw new Error(`bundleFromStatement: no account for ${unresolved.map((n) => JSON.stringify(n)).join(', ')} — resolve it or refuse the document`);
  }

  return {
    document: { hash: document.hash, name: document.name ?? null },
    sections,
    extras: {
      issuer: statement.issuer ?? null,
      documentType: statement.documentType ?? null,
      ignored: statement.ignored ?? [],
    },
  };
}
