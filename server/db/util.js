'use strict';

/** Small helpers shared by the database layer. */

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isDocument(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.toObject === 'function' &&
    value.constructor &&
    typeof value.constructor.modelName === 'string'
  );
}

function splitPath(path) {
  return Array.isArray(path) ? path : String(path).split('.');
}

function getPath(obj, path) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (cur[key] === null || typeof cur[key] !== 'object') {
      cur[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, path) {
  const parts = splitPath(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur = cur[parts[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  delete cur[parts[parts.length - 1]];
}

/** Deep copy. Documents are converted with toJSON (json=true) or toObject. */
function deepClone(value, json = false) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((v) => deepClone(v, json));
  if (isDocument(value)) return json ? value.toJSON() : value.toObject();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== undefined) out[key] = deepClone(value[key], json);
    }
    return out;
  }
  return value;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Removes empty nested objects (Mongoose's `minimize`). Mutates and returns the argument. */
function minimize(obj) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    if (value === undefined) {
      delete obj[key];
    } else if (isPlainObject(value)) {
      minimize(value);
      if (Object.keys(value).length === 0) delete obj[key];
    } else if (Array.isArray(value)) {
      for (const el of value) if (isPlainObject(el)) minimize(el);
    }
  }
  return obj;
}

/**
 * Differences between two plain documents expressed as leaf-level operations.
 * Stops descending as soon as one side is not an object, so a missing parent is written whole
 * (SQLite's json_set cannot create intermediate objects).
 */
function diffObjects(oldObj, newObj, prefix = '', out = { sets: new Map(), unsets: new Set() }) {
  const keys = new Set([...Object.keys(oldObj || {}), ...Object.keys(newObj || {})]);
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const before = oldObj ? oldObj[key] : undefined;
    const after = newObj ? newObj[key] : undefined;
    if (after === undefined) {
      if (before !== undefined) out.unsets.add(path);
    } else if (before === undefined) {
      out.sets.set(path, after);
    } else if (isPlainObject(before) && isPlainObject(after)) {
      diffObjects(before, after, path, out);
    } else if (!deepEqual(before, after)) {
      out.sets.set(path, after);
    }
  }
  return out;
}

/** "a.b.0.c" -> "$.a.b[0].c" for SQLite JSON functions. */
function toJsonPath(path) {
  let out = '$';
  for (const part of splitPath(path)) {
    if (/^\d+$/.test(part)) out += `[${part}]`;
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) out += `.${part}`;
    else out += `."${part.replace(/"/g, '\\"')}"`;
  }
  return out;
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

module.exports = {
  isPlainObject,
  isDocument,
  splitPath,
  getPath,
  setPath,
  unsetPath,
  deepClone,
  deepEqual,
  minimize,
  diffObjects,
  toJsonPath,
  chunk,
};
