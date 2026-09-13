/**
 * validate.js — a validator over the subset of JSON Schema the model uses.
 *
 * The library has no dependencies by rule (guards/importDirection.js), so the
 * validator is written here rather than imported. It covers exactly the
 * keywords schema.js uses — type (incl. the [T, 'null'] form), properties,
 * required, additionalProperties:false, items, minItems, minLength, minimum,
 * pattern, integer — and REJECTS any schema keyword it does not implement, so
 * a future schema edit cannot silently go unchecked.
 *
 * Errors carry a JSON-pointer-style path and a message; the list is complete,
 * never first-failure-only, because the agent feeds it back to the model.
 */

const IMPLEMENTED = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'minItems',
  'minLength', 'minimum', 'pattern', 'enum',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  const actual = typeOf(value);
  for (const t of types) {
    if (t === 'integer') {
      if (actual === 'number' && Number.isInteger(value)) return true;
    } else if (t === 'number') {
      if (actual === 'number' && Number.isFinite(value)) return true;
    } else if (t === actual) {
      return true;
    }
  }
  return false;
}

/**
 * Validate `value` against `schema`. Returns { ok, errors: [{ path, message }] }.
 */
export function validateAgainst(schema, value, path = '', errors = []) {
  for (const key of Object.keys(schema)) {
    if (!IMPLEMENTED.has(key)) {
      throw new Error(`validateAgainst: schema keyword "${key}" at ${path || '/'} is not implemented — extend validate.js before using it`);
    }
  }

  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join(' | ') : schema.type;
    errors.push({ path: path || '/', message: `expected ${want}, got ${typeOf(value)}` });
    return { ok: errors.length === 0, errors };
  }

  if (value === null) return { ok: errors.length === 0, errors };

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path: path || '/', message: `expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path: path || '/', message: `string shorter than ${schema.minLength}` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path: path || '/', message: `"${value}" does not match ${schema.pattern}` });
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path: path || '/', message: `${value} is below the minimum ${schema.minimum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path: path || '/', message: `array has ${value.length} item(s); at least ${schema.minItems} required` });
    }
    if (schema.items) {
      value.forEach((item, i) => validateAgainst(schema.items, item, `${path}/${i}`, errors));
    }
  }

  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path: `${path}/${key}`, message: 'required property missing' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) validateAgainst(sub, value[key], `${path}/${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push({ path: `${path}/${key}`, message: 'property not in the model' });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
