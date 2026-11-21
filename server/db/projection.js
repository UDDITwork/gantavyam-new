'use strict';

/** Field selection (`.select('a b -c +d')`, `{ a: 1 }`) applied to raw documents. */

const { isPlainObject } = require('./util');

function parseSelect(arg) {
  const spec = { include: new Set(), exclude: new Set(), plus: new Set() };
  const addToken = (token) => {
    if (!token) return;
    if (token[0] === '-') spec.exclude.add(token.slice(1));
    else if (token[0] === '+') spec.plus.add(token.slice(1));
    else spec.include.add(token);
  };

  if (typeof arg === 'string') {
    arg.split(/\s+/).forEach(addToken);
  } else if (Array.isArray(arg)) {
    arg.forEach((item) => typeof item === 'string' && item.split(/\s+/).forEach(addToken));
  } else if (isPlainObject(arg)) {
    for (const [key, value] of Object.entries(arg)) {
      if (value === 0 || value === false) spec.exclude.add(key);
      else if (value) spec.include.add(key);
    }
  }
  return spec;
}

function mergeSpecs(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    include: new Set([...a.include, ...b.include]),
    exclude: new Set([...a.exclude, ...b.exclude]),
    plus: new Set([...a.plus, ...b.plus]),
  };
}

/** Copies `parts` from src into dst, walking through arrays of sub-documents. */
function pick(src, parts, i, dst) {
  const key = parts[i];
  const value = src[key];
  if (value === undefined) return;
  if (i === parts.length - 1) {
    dst[key] = value;
    return;
  }
  if (Array.isArray(value)) {
    if (!dst[key]) dst[key] = value.map(() => ({}));
    value.forEach((el, idx) => {
      if (el && typeof el === 'object') pick(el, parts, i + 1, dst[key][idx]);
    });
  } else if (value && typeof value === 'object') {
    if (!dst[key]) dst[key] = {};
    pick(value, parts, i + 1, dst[key]);
  }
}

function remove(obj, parts, i) {
  if (obj === null || typeof obj !== 'object') return;
  const key = parts[i];
  if (i === parts.length - 1) {
    delete obj[key];
    return;
  }
  const next = obj[key];
  if (Array.isArray(next)) next.forEach((el) => remove(el, parts, i + 1));
  else remove(next, parts, i + 1);
}

/** Describes which paths of a schema are selected, so required checks can skip the rest. */
class Selection {
  constructor(schema, spec) {
    const safe = spec || { include: new Set(), exclude: new Set(), plus: new Set() };
    this.inclusion = safe.include.size > 0;
    this.include = [...safe.include, ...safe.plus];
    this.exclude = [...safe.exclude];
    this.plus = [...safe.plus];
    this.defaultExcluded = schema
      ? [...schema.paths].filter(([, desc]) => !desc.selectByDefault).map(([p]) => p)
      : [];
  }

  isSelected(path) {
    const within = (list) => list.some((p) => path === p || path.startsWith(`${p}.`));
    if (this.inclusion) return path === '_id' ? !this.exclude.includes('_id') : within(this.include);
    if (within(this.exclude)) return false;
    if (within(this.defaultExcluded) && !within(this.plus)) return false;
    return true;
  }
}

/** Returns the raw document restricted to the selected fields. */
function applyProjection(raw, spec, schema) {
  if (!spec) {
    const defaults = schema ? [...schema.paths].filter(([, d]) => !d.selectByDefault).map(([p]) => p) : [];
    for (const p of defaults) remove(raw, p.split('.'), 0);
    return raw;
  }

  if (spec.include.size > 0) {
    const out = {};
    if (!spec.exclude.has('_id') && raw._id !== undefined) out._id = raw._id;
    for (const p of [...spec.include, ...spec.plus]) {
      if (p === '_id') continue;
      pick(raw, p.split('.'), 0, out);
    }
    return out;
  }

  for (const p of spec.exclude) remove(raw, p.split('.'), 0);
  const defaults = schema ? [...schema.paths].filter(([, d]) => !d.selectByDefault).map(([p]) => p) : [];
  for (const p of defaults) {
    if (!spec.plus.has(p)) remove(raw, p.split('.'), 0);
  }
  return raw;
}

module.exports = { parseSelect, mergeSpecs, applyProjection, Selection };
