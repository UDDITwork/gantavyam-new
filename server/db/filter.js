'use strict';

/**
 * Query filters: normalisation (casting values to the stored representation), translation of
 * the simple, index-friendly parts into SQL, and geo helpers.
 *
 * Every SQL translation is conservative: it may return a superset of the matching documents,
 * and the caller then re-checks the full MongoDB-style filter in memory with mingo unless the
 * translation reports `exact: true`.
 */

const { toHex } = require('./objectid');
const { CastError } = require('./errors');
const { castScalar } = require('./cast');
const { isPlainObject, isDocument, toJsonPath } = require('./util');

const SCALAR_KINDS = new Set(['String', 'Number', 'Boolean', 'Date', 'ObjectId']);

/** The SQL expression for a document path. Indexes and queries must use exactly this text. */
function jsonExtract(path) {
  return `json_extract(doc, '${toJsonPath(path)}')`;
}

function jsonType(path) {
  return `json_type(doc, '${toJsonPath(path)}')`;
}

/** Finds the descriptor for a path, looking through arrays of sub-documents. */
function resolveDescriptor(schema, path) {
  const direct = schema.paths.get(path);
  if (direct) return direct;
  const parts = path.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const desc = schema.paths.get(parts.slice(0, i).join('.'));
    if (desc && desc.kind === 'DocumentArray') {
      let rest = parts.slice(i);
      if (/^\d+$/.test(rest[0])) rest = rest.slice(1);
      return rest.length ? resolveDescriptor(desc.schema, rest.join('.')) : desc;
    }
  }
  return null;
}

function hasOperators(obj) {
  return isPlainObject(obj) && Object.keys(obj).some((k) => k.startsWith('$'));
}

/** Casts one filter value to the representation used inside stored JSON documents. */
function normalizeScalar(desc, value, path, modelName) {
  if (value === undefined || value === null) return null;
  if (value instanceof RegExp) return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  const kind = desc ? (desc.kind === 'Array' ? desc.caster.kind : desc.kind) : null;

  try {
    switch (kind) {
      case 'ObjectId': {
        const hex = toHex(value) || (isDocument(value) ? toHex(value._id) : null);
        if (!hex) throw new CastError('ObjectId', value, path);
        return hex;
      }
      case 'Date': {
        const d = castScalar('Date', value, path);
        return d === null ? null : d.toISOString();
      }
      case 'Number':
      case 'Boolean':
      case 'String':
        return castScalar(kind, value, path);
      default:
        break;
    }
  } catch (e) {
    if (e instanceof CastError && modelName) throw new CastError(e.kind, e.value, e.path, modelName);
    throw e;
  }

  const hex = toHex(value);
  if (hex && typeof value === 'object') return hex;
  if (isDocument(value)) return toHex(value._id) || value;
  return value;
}

function normalizeCondition(schema, path, value, modelName) {
  const desc = resolveDescriptor(schema, path);
  const one = (v) => normalizeScalar(desc, v, path, modelName);

  if (value instanceof RegExp) return value;

  if (hasOperators(value)) {
    const out = {};
    for (const op of Object.keys(value)) {
      const v = value[op];
      switch (op) {
        case '$in':
        case '$nin':
        case '$all':
          out[op] = (Array.isArray(v) ? v : [v]).map(one);
          break;
        case '$eq':
        case '$ne':
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte':
          out[op] = one(v);
          break;
        case '$not':
          out[op] = hasOperators(v) ? normalizeCondition(schema, path, v, modelName) : v;
          break;
        case '$elemMatch':
          out[op] = desc && desc.kind === 'DocumentArray' ? normalizeFilter(desc.schema, v, modelName) : v;
          break;
        default:
          out[op] = v;
      }
    }
    return out;
  }

  if (Array.isArray(value)) return value.map(one);
  if (isPlainObject(value)) return value;
  return one(value);
}

/** Returns a copy of `filter` whose values are cast for the given schema. */
function normalizeFilter(schema, filter, modelName) {
  const out = {};
  for (const key of Object.keys(filter || {})) {
    const value = filter[key];
    if (key === '$and' || key === '$or' || key === '$nor') {
      out[key] = value.map((f) => normalizeFilter(schema, f, modelName));
    } else if (key.startsWith('$')) {
      out[key] = value;
    } else {
      out[key] = normalizeCondition(schema, key, value, modelName);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ geo ($near) */

const EARTH_RADIUS_M = 6378100;

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Splits a `$near` / `$nearSphere` condition (GeoJSON `$geometry` form) out of the filter.
 * Returns { rest, geo } where geo = { path, lng, lat, maxDistance, minDistance }.
 */
function extractGeo(filter) {
  let geo = null;
  const rest = {};
  for (const key of Object.keys(filter)) {
    const value = filter[key];
    const near = isPlainObject(value) ? value.$near || value.$nearSphere : null;
    if (near && isPlainObject(near) && near.$geometry && Array.isArray(near.$geometry.coordinates)) {
      const [lng, lat] = near.$geometry.coordinates;
      geo = {
        path: key,
        lng,
        lat,
        maxDistance: near.$maxDistance === undefined ? Infinity : near.$maxDistance,
        minDistance: near.$minDistance || 0,
      };
    } else {
      rest[key] = value;
    }
  }
  return { rest, geo };
}

/** Filters and sorts raw documents by distance from the point (nearest first). */
function applyGeo(docs, geo) {
  const withDistance = [];
  for (const doc of docs) {
    const point = geo.path.split('.').reduce((cur, k) => (cur === undefined || cur === null ? undefined : cur[k]), doc);
    const coords = point && (Array.isArray(point) ? point : point.coordinates);
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const d = distanceMeters(geo.lat, geo.lng, coords[1], coords[0]);
    if (d <= geo.maxDistance && d >= geo.minDistance) withDistance.push({ doc, d });
  }
  withDistance.sort((a, b) => a.d - b.d);
  return withDistance.map((x) => x.doc);
}

/* ------------------------------------------------------------------ SQL translation */

function sqlParam(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function and(frags) {
  const live = frags.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];
  return { sql: live.map((f) => `(${f.sql})`).join(' AND '), params: live.flatMap((f) => f.params) };
}

function or(frags) {
  if (frags.length === 0) return { sql: '0', params: [] };
  if (frags.length === 1) return frags[0];
  return { sql: frags.map((f) => `(${f.sql})`).join(' OR '), params: frags.flatMap((f) => f.params) };
}

function listFragment(col, values, negate) {
  const hasNull = values.some((v) => v === null);
  const rest = values.filter((v) => v !== null);
  const placeholders = rest.map(() => '?').join(', ');

  if (!negate) {
    const parts = [];
    if (rest.length) parts.push({ sql: `${col} IN (${placeholders})`, params: rest.map(sqlParam) });
    if (hasNull) parts.push({ sql: `${col} IS NULL`, params: [] });
    return or(parts);
  }

  if (values.length === 0) return { sql: '1', params: [] };
  if (hasNull) {
    return {
      sql: rest.length ? `${col} IS NOT NULL AND ${col} NOT IN (${placeholders})` : `${col} IS NOT NULL`,
      params: rest.map(sqlParam),
    };
  }
  return { sql: `(${col} IS NULL OR ${col} NOT IN (${placeholders}))`, params: rest.map(sqlParam) };
}

/** Translates the conditions on one path. Returns { frag, exact }. */
function translateCondition(schema, path, value) {
  const isId = path === '_id';
  const desc = schema.paths.get(path);
  if (!isId && !(desc && SCALAR_KINDS.has(desc.kind))) return { frag: null, exact: false };

  const col = isId ? '_id' : jsonExtract(path);
  const typeCol = isId ? null : jsonType(path);

  if (value instanceof RegExp || Array.isArray(value)) return { frag: null, exact: false };

  if (!hasOperators(value)) {
    if (isPlainObject(value)) return { frag: null, exact: false };
    if (value === null) return { frag: { sql: `${col} IS NULL`, params: [] }, exact: true };
    return { frag: { sql: `${col} = ?`, params: [sqlParam(value)] }, exact: true };
  }

  const frags = [];
  let exact = true;

  for (const op of Object.keys(value)) {
    const v = value[op];
    switch (op) {
      case '$eq':
        frags.push(v === null ? { sql: `${col} IS NULL`, params: [] } : { sql: `${col} = ?`, params: [sqlParam(v)] });
        break;
      case '$ne':
        frags.push(
          v === null
            ? { sql: `${col} IS NOT NULL`, params: [] }
            : { sql: `(${col} IS NULL OR ${col} != ?)`, params: [sqlParam(v)] }
        );
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte': {
        const symbol = { $gt: '>', $gte: '>=', $lt: '<', $lte: '<=' }[op];
        if (typeof v === 'number') {
          frags.push({
            sql: isId ? `${col} ${symbol} ?` : `(${typeCol} IN ('integer', 'real') AND ${col} ${symbol} ?)`,
            params: [v],
          });
        } else if (typeof v === 'string') {
          frags.push({
            sql: isId ? `${col} ${symbol} ?` : `(${typeCol} = 'text' AND ${col} ${symbol} ?)`,
            params: [v],
          });
        } else {
          exact = false;
        }
        break;
      }
      case '$in':
        frags.push(listFragment(col, v, false));
        break;
      case '$nin':
        frags.push(listFragment(col, v, true));
        break;
      case '$exists':
        if (isId) frags.push({ sql: v ? '1' : '0', params: [] });
        else frags.push({ sql: v ? `${typeCol} IS NOT NULL` : `${typeCol} IS NULL`, params: [] });
        break;
      default:
        // $regex, $options, $not, $size, $all, $elemMatch, ... are verified in memory
        exact = false;
    }
  }

  return { frag: and(frags), exact };
}

/** Translates a normalised filter. Returns { frag: {sql, params}|null, exact }. */
function translateFilter(schema, filter) {
  const frags = [];
  let exact = true;

  for (const key of Object.keys(filter)) {
    const value = filter[key];

    if (key === '$and') {
      const subs = value.map((f) => translateFilter(schema, f));
      for (const s of subs) {
        if (s.frag) frags.push(s.frag);
        if (!s.exact) exact = false;
      }
    } else if (key === '$or') {
      const subs = value.map((f) => translateFilter(schema, f));
      if (subs.every((s) => s.frag)) {
        frags.push(or(subs.map((s) => s.frag)));
        if (!subs.every((s) => s.exact)) exact = false;
      } else {
        exact = false;
      }
    } else if (key.startsWith('$')) {
      exact = false;
    } else {
      const r = translateCondition(schema, key, value);
      if (r.frag) frags.push(r.frag);
      if (!r.exact) exact = false;
    }
  }

  return { frag: and(frags), exact };
}

/**
 * ORDER BY for a sort spec, or null when some key cannot be sorted in SQL.
 * Ties fall back to insertion order (rowid) to keep results deterministic.
 */
function translateSort(schema, sort) {
  const keys = Object.keys(sort || {});
  if (keys.length === 0) return 'rowid ASC';
  const parts = [];
  for (const key of keys) {
    const desc = schema.paths.get(key);
    const direction = sort[key] === -1 || sort[key] === 'desc' || sort[key] === 'descending' ? 'DESC' : 'ASC';
    if (key === '_id') parts.push(`_id ${direction}`);
    else if (desc && SCALAR_KINDS.has(desc.kind)) parts.push(`${jsonExtract(key)} ${direction}`);
    else return null;
  }
  parts.push('rowid ASC');
  return parts.join(', ');
}

module.exports = {
  jsonExtract,
  jsonType,
  resolveDescriptor,
  hasOperators,
  normalizeScalar,
  normalizeFilter,
  extractGeo,
  applyGeo,
  distanceMeters,
  translateFilter,
  translateSort,
  sqlParam,
  SCALAR_KINDS,
};
