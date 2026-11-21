'use strict';

/**
 * Casting, defaults and validation of document data against a Schema.
 *
 * Stored representation (what lives in `_doc` and in the JSON column):
 *   String/Number/Boolean as-is, ObjectId as a 24-char hex string, Date as a Date object in
 *   memory (ISO string once serialised), arrays as arrays, sub-documents as plain objects.
 */

const { CastError, ValidatorError } = require('./errors');
const { ObjectId, toHex, generateHex } = require('./objectid');
const { isPlainObject, isDocument, getPath, setPath } = require('./util');

function applyStringTransforms(desc, value) {
  let out = value;
  if (desc.transforms) {
    if (desc.transforms.trim) out = out.trim();
    if (desc.transforms.lowercase) out = out.toLowerCase();
    if (desc.transforms.uppercase) out = out.toUpperCase();
  }
  return out;
}

/** Casts a single scalar. Throws CastError when the value cannot be converted. */
function castScalar(kind, value, path, desc) {
  if (value === undefined || value === null) return value;

  switch (kind) {
    case 'String': {
      let out;
      if (typeof value === 'string') out = value;
      else if (typeof value === 'number' || typeof value === 'boolean') out = String(value);
      else if (value instanceof Date) out = value.toString();
      else if (toHex(value)) out = toHex(value);
      else throw new CastError('string', value, path);
      return desc ? applyStringTransforms(desc, out) : out;
    }
    case 'Number': {
      if (typeof value === 'number') {
        if (Number.isNaN(value)) throw new CastError('Number', value, path);
        return value;
      }
      if (typeof value === 'string') {
        if (value.trim() === '') return null;
        const n = Number(value);
        if (Number.isNaN(n)) throw new CastError('Number', value, path);
        return n;
      }
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value instanceof Date) return value.getTime();
      throw new CastError('Number', value, path);
    }
    case 'Boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1 || value === '1' || value === 'yes') return true;
      if (value === 'false' || value === 0 || value === '0' || value === 'no') return false;
      throw new CastError('boolean', value, path);
    }
    case 'Date': {
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) throw new CastError('date', value, path);
        return value;
      }
      if (typeof value === 'number') {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) throw new CastError('date', value, path);
        return d;
      }
      if (typeof value === 'string') {
        if (value === '') return null;
        const d = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
        if (Number.isNaN(d.getTime())) throw new CastError('date', value, path);
        return d;
      }
      throw new CastError('date', value, path);
    }
    case 'ObjectId': {
      const hex = toHex(value) || (isDocument(value) ? toHex(value._id) : null) || (value && typeof value === 'object' && value._id !== undefined ? toHex(value._id) : null);
      if (!hex) throw new CastError('ObjectId', value, path);
      return hex;
    }
    case 'Mixed':
    default:
      return value;
  }
}

/** Casts a value for a path descriptor (handles arrays and arrays of sub-documents). */
function castPath(desc, value, errors, errPath) {
  if (value === undefined || value === null) return value;

  if (desc.kind === 'Array') {
    const list = Array.isArray(value) ? value : [value];
    return list.map((el, i) => {
      try {
        return castScalar(desc.caster.kind, el, `${errPath || desc.path}.${i}`, desc.caster);
      } catch (e) {
        if (e instanceof CastError && errors) {
          errors[`${errPath || desc.path}.${i}`] = e;
          return el;
        }
        throw e;
      }
    });
  }

  if (desc.kind === 'DocumentArray') {
    const list = Array.isArray(value) ? value : [value];
    return list.map((el, i) => castSubdocument(desc.schema, el, errors, `${errPath || desc.path}.${i}.`));
  }

  return castScalar(desc.kind, value, errPath || desc.path, desc);
}

function castSubdocument(schema, input, errors, errPrefix) {
  const source = isDocument(input) ? input.toObject() : input;
  const out = {};
  if (isPlainObject(source)) castInto(schema, out, source, errors, '', errPrefix);
  applyDefaults(schema, out);
  ensureNested(schema, out);
  return out;
}

/**
 * Sets `value` at `path` (a dotted schema path), casting it. Unknown paths are ignored (strict mode).
 * Returns true when the path is part of the schema.
 */
function setValue(schema, target, path, value, errors, errPrefix = '') {
  const desc = schema.paths.get(path);
  if (desc) {
    try {
      const cast = castPath(desc, value, errors, `${errPrefix}${path}`);
      setPath(target, path, cast);
    } catch (e) {
      if (e instanceof CastError && errors) errors[`${errPrefix}${path}`] = e;
      else throw e;
    }
    return true;
  }

  if (schema.nested.has(path)) {
    const source = isDocument(value) ? value.toObject() : value;
    if (isPlainObject(source)) {
      setPath(target, path, {});
      for (const key of Object.keys(source)) {
        if (source[key] !== undefined) setValue(schema, target, `${path}.${key}`, source[key], errors, errPrefix);
      }
    } else if (source === null) {
      setPath(target, path, {});
    }
    return true;
  }

  return false;
}

function castInto(schema, target, input, errors, prefix = '', errPrefix = '') {
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) continue;
    setValue(schema, target, prefix ? `${prefix}.${key}` : key, input[key], errors, errPrefix);
  }
}

function applyDefaults(schema, target, shouldApply) {
  for (const [path, desc] of schema.paths) {
    if (!desc.hasDefault && !desc.auto) continue;
    if (shouldApply && !shouldApply(path)) continue;
    if (getPath(target, path) !== undefined) continue;

    let value = desc.auto ? generateHex() : desc.getDefault(target);
    if (value === undefined) continue;
    try {
      value = castPath(desc, value);
    } catch (e) {
      continue;
    }
    setPath(target, path, value);
  }
}

function ensureNested(schema, target) {
  for (const path of schema.nested) {
    if (getPath(target, path) === undefined) setPath(target, path, {});
  }
}

/** Converts ISO strings back to Date objects for every Date path (in place). */
function reviveDates(schema, obj) {
  const reviveValue = (v) => {
    if (typeof v !== 'string' && typeof v !== 'number') return v;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  };

  for (const [path, desc] of schema.paths) {
    if (desc.kind !== 'Date' && !(desc.kind === 'Array' && desc.caster.kind === 'Date') && desc.kind !== 'DocumentArray') continue;

    const parts = path.split('.');
    let parent = obj;
    for (let i = 0; i < parts.length - 1 && parent !== undefined && parent !== null; i += 1) parent = parent[parts[i]];
    if (parent === undefined || parent === null || typeof parent !== 'object') continue;

    const key = parts[parts.length - 1];
    const value = parent[key];
    if (value === undefined || value === null) continue;

    if (desc.kind === 'Date') parent[key] = reviveValue(value);
    else if (desc.kind === 'Array') parent[key] = value.map(reviveValue);
    else if (Array.isArray(value)) value.forEach((el) => isPlainObject(el) && reviveDates(desc.schema, el));
  }
  return obj;
}

function isMissing(desc, value) {
  if (value === undefined || value === null) return true;
  if (desc.kind === 'String') return value === '';
  return false;
}

/**
 * Runs required checks and validators. `ctx` supplies `doc` (the `this` for validators) and
 * `shouldCheckRequired(path)`. Errors are collected into `errors` keyed by full path.
 */
async function validateObject(schema, target, ctx, prefix, errors) {
  for (const [path, desc] of schema.paths) {
    if (path === '_id') continue;
    const value = getPath(target, path);
    const fullPath = `${prefix}${path}`;

    if (desc.required && ctx.shouldCheckRequired(fullPath)) {
      const needed = desc.required.condition ? desc.required.condition.call(ctx.doc) : true;
      if (needed && isMissing(desc, value)) {
        errors[fullPath] = new ValidatorError({ type: 'required', path: fullPath, value, message: desc.required.message });
        continue;
      }
    }

    if (value === undefined || errors[fullPath]) continue;

    let failed = false;
    for (const validator of desc.validators) {
      let ok;
      try {
        ok = validator.test.call(ctx.doc, value);
        if (ok && typeof ok.then === 'function') ok = await ok;
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        errors[fullPath] = new ValidatorError({ type: validator.type, path: fullPath, value, message: validator.message(value) });
        failed = true;
        break;
      }
    }
    if (failed) continue;

    if (desc.kind === 'Array' && desc.caster.validators.length && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        for (const validator of desc.caster.validators) {
          let ok;
          try {
            ok = validator.test.call(ctx.doc, value[i]);
          } catch (e) {
            ok = false;
          }
          if (!ok) {
            const elementPath = `${fullPath}.${i}`;
            errors[elementPath] = new ValidatorError({
              type: validator.type,
              path: elementPath,
              value: value[i],
              message: validator.message(value[i]).split(`\`${path}\``).join(`\`${elementPath}\``),
            });
            break;
          }
        }
      }
    }

    if (desc.kind === 'DocumentArray' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        await validateObject(desc.schema, value[i], { ...ctx, shouldCheckRequired: () => true }, `${fullPath}.${i}.`, errors);
      }
    }
  }
}

module.exports = {
  castScalar,
  castPath,
  castInto,
  castSubdocument,
  setValue,
  applyDefaults,
  ensureNested,
  reviveDates,
  validateObject,
  ObjectId,
};
