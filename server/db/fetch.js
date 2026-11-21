'use strict';

/**
 * Reading documents: SQL pre-filtering, in-memory verification with mingo, sorting/paging,
 * projection, hydration and populate.
 */

const { Query: MingoQuery } = require('mingo');
const { quote } = require('./client');
const { extractGeo, applyGeo, translateFilter, translateSort } = require('./filter');
const { Selection, applyProjection } = require('./projection');
const { reviveDates } = require('./cast');
const { MongooseError, MissingSchemaError } = require('./errors');
const { isDocument, getPath } = require('./util');

function rowToRaw(row) {
  return { _id: row._id, ...JSON.parse(row.doc) };
}

/* ---------------------------------------------------------------- in-memory sorting */

function rank(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return 1;
  if (typeof value === 'string') return 2;
  if (Array.isArray(value)) return 4;
  if (typeof value === 'object') return 3;
  if (typeof value === 'boolean') return 5;
  return 6;
}

function compareValues(a, b) {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 5) return Number(a) - Number(b);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortDocs(docs, sort) {
  const keys = Object.entries(sort || {}).map(([key, dir]) => [key, dir === -1 || dir === 'desc' || dir === 'descending' ? -1 : 1]);
  if (keys.length === 0) return docs;
  return docs.slice().sort((a, b) => {
    for (const [key, dir] of keys) {
      const c = compareValues(getPath(a, key), getPath(b, key));
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

/* ---------------------------------------------------------------- fetching */

/**
 * Returns the raw (JSON-parsed) documents matching a normalised filter, already sorted and paged.
 * Dates are still ISO strings and ids are hex strings at this stage.
 */
async function fetchRaw(Model, filter, { sort, limit, skip } = {}) {
  const { schema, collectionName, db } = Model;
  const { rest, geo } = extractGeo(filter);
  const { frag, exact } = translateFilter(schema, rest);

  const hasSort = sort && Object.keys(sort).length > 0;
  const orderBy = translateSort(schema, sort);
  const pushPaging = exact && orderBy !== null && !geo;
  const max = limit && limit > 0 ? limit : null;
  const offset = skip && skip > 0 ? skip : 0;

  let sql = `SELECT _id, doc FROM ${quote(collectionName)}`;
  const params = [];
  if (frag) {
    sql += ` WHERE ${frag.sql}`;
    params.push(...frag.params);
  }

  if (pushPaging) {
    sql += ` ORDER BY ${orderBy}`;
    if (max !== null) {
      sql += ' LIMIT ?';
      params.push(max);
      if (offset) {
        sql += ' OFFSET ?';
        params.push(offset);
      }
    } else if (offset) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(offset);
    }
  } else {
    sql += ' ORDER BY rowid ASC';
  }

  const result = await db.execute(sql, params);
  let docs = result.rows.map(rowToRaw);

  if (!exact) {
    const matcher = new MingoQuery(rest);
    docs = docs.filter((d) => matcher.test(d));
  }
  if (geo) docs = applyGeo(docs, geo);

  if (!pushPaging) {
    if (hasSort) docs = sortDocs(docs, sort);
    if (offset) docs = docs.slice(offset);
    if (max !== null) docs = docs.slice(0, max);
  }
  return docs;
}

async function countRaw(Model, filter) {
  const { schema, collectionName, db } = Model;
  const { rest, geo } = extractGeo(filter);
  const { frag, exact } = translateFilter(schema, rest);

  if (exact && !geo) {
    let sql = `SELECT COUNT(*) AS n FROM ${quote(collectionName)}`;
    const params = [];
    if (frag) {
      sql += ` WHERE ${frag.sql}`;
      params.push(...frag.params);
    }
    const result = await db.execute(sql, params);
    return Number(result.rows[0].n);
  }
  return (await fetchRaw(Model, filter)).length;
}

/* ---------------------------------------------------------------- results */

/** The result-shaping options of a Query (select / lean / populate). */
function queryOptions(q) {
  return { select: q._select, lean: q._lean, populate: q._populate };
}

async function finalize(Model, raws, q) {
  const { select, lean, populate } = queryOptions(q);
  const { schema } = Model;
  let results;
  if (lean) {
    results = raws.map((raw) => {
      reviveDates(schema, raw);
      return applyProjection(raw, select, schema);
    });
  } else {
    const selection = new Selection(schema, select);
    results = raws.map((raw) => Model._hydrate(applyProjection(raw, select, schema), selection));
  }
  if (populate && populate.length) await populateResults(Model, results, populate, lean);
  return results;
}

/* ---------------------------------------------------------------- populate */

function describeRef(schema, path) {
  const direct = schema.paths.get(path);
  if (direct) {
    if (direct.ref) return { ref: direct.ref };
    if (direct.kind === 'Array' && direct.caster && direct.caster.ref) return { ref: direct.caster.ref };
    return null;
  }
  const parts = path.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const arr = schema.paths.get(parts.slice(0, i).join('.'));
    if (arr && arr.kind === 'DocumentArray') return describeRef(arr.schema, parts.slice(i).join('.'));
  }
  return null;
}

/** Calls fn(container, key) for every place the dotted path points at (walking through arrays). */
function eachSlot(data, parts, i, fn) {
  if (data === null || typeof data !== 'object') return;
  const key = parts[i];
  if (i === parts.length - 1) {
    fn(data, key);
    return;
  }
  const next = data[key];
  if (Array.isArray(next)) next.forEach((el) => eachSlot(el, parts, i + 1, fn));
  else eachSlot(next, parts, i + 1, fn);
}

function dataOf(doc) {
  return isDocument(doc) ? doc._doc : doc;
}

async function populateResults(Model, docs, specs, lean) {
  const live = docs.filter(Boolean);
  if (live.length === 0) return;
  for (const spec of specs) {
    for (const path of String(spec.path).split(/\s+/).filter(Boolean)) {
      await populatePath(Model, live, { ...spec, path }, lean);
    }
  }
}

async function populatePath(Model, docs, spec, lean) {
  const info = describeRef(Model.schema, spec.path);
  const refName = spec.model ? (typeof spec.model === 'string' ? spec.model : spec.model.modelName) : info && info.ref;
  if (!refName) {
    throw new MongooseError(`Cannot populate path \`${spec.path}\` because it is not in your schema. Set the \`strictPopulate\` option to false to override.`);
  }
  const RefModel = Model.db.models.get(refName);
  if (!RefModel) throw new MissingSchemaError(refName);

  const parts = spec.path.split('.');
  const ids = new Set();
  const isId = (v) => typeof v === 'string';

  for (const doc of docs) {
    eachSlot(dataOf(doc), parts, 0, (container, key) => {
      const value = container[key];
      if (Array.isArray(value)) value.filter(isId).forEach((v) => ids.add(v));
      else if (isId(value)) ids.add(value);
    });
  }

  const found = new Map();
  if (ids.size > 0) {
    let query = RefModel.find({ _id: { $in: [...ids] } });
    if (spec.select) query = query.select(spec.select);
    if (spec.populate) query = query.populate(spec.populate);
    query.lean(lean);
    for (const child of await query.exec()) found.set(String(child._id), child);
  }

  for (const doc of docs) {
    eachSlot(dataOf(doc), parts, 0, (container, key) => {
      const value = container[key];
      if (Array.isArray(value)) container[key] = value.map((v) => (isId(v) ? found.get(v) : v)).filter((v) => v !== undefined);
      else if (isId(value)) container[key] = found.get(value) || null;
    });
    if (isDocument(doc)) doc._populatedPaths.add(spec.path);
  }
}

module.exports = { rowToRaw, sortDocs, fetchRaw, countRaw, finalize, populateResults, eachSlot };
