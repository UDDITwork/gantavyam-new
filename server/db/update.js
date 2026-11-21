'use strict';

/**
 * Updates and deletes: updateOne / updateMany / findOneAndUpdate (with upsert) / deleteOne /
 * deleteMany / findOneAndDelete. Supported update operators: $set, $unset, $inc, $setOnInsert
 * (plain top-level fields count as $set). Updates are applied with SQLite JSON functions so that
 * concurrent writers to different fields do not overwrite each other, and `$inc` is atomic.
 */

const { normalizeFilter, translateFilter, extractGeo, resolveDescriptor } = require('./filter');
const { fetchRaw, finalize, rowToRaw } = require('./fetch');
const { quote } = require('./client');
const { castPath, castScalar, castInto, applyDefaults, ensureNested } = require('./cast');
const { MongooseError } = require('./errors');
const { toJsonPath, isPlainObject, setPath, getPath, unsetPath, minimize, deepClone, chunk } = require('./util');

const OPERATORS = ['$set', '$unset', '$inc', '$setOnInsert'];

function parseUpdate(Model, update, options = {}) {
  const { schema } = Model;
  if (Array.isArray(update)) {
    throw new MongooseError('Update pipelines are not supported (Unrecognized pipeline stage name)');
  }

  const operators = { $set: {}, $unset: {}, $inc: {}, $setOnInsert: {} };
  for (const key of Object.keys(update || {})) {
    if (key.startsWith('$')) {
      if (!OPERATORS.includes(key)) throw new MongooseError(`Unsupported update operator: ${key}`);
      Object.assign(operators[key], update[key]);
    } else {
      operators.$set[key] = update[key];
    }
  }

  const ops = { set: new Map(), unset: new Set(), inc: new Map(), setOnInsert: new Map() };

  const castUpdateValue = (path, value) => {
    const desc = schema.paths.get(path);
    if (desc) return castPath(desc, value, null, path);
    if (schema.nested.has(path)) {
      const temp = {};
      castInto(schema, temp, { [path]: value }, null);
      return getPath(temp, path);
    }
    const inner = resolveDescriptor(schema, path);
    return inner ? castPath(inner, value, null, path) : value;
  };

  const collect = (source, target) => {
    for (const [path, value] of Object.entries(source)) {
      // strict mode: values for unknown paths are silently dropped; _id is immutable
      if (value === undefined || path === '_id' || !schema.hasPath(path)) continue;
      if (path.includes('.$')) throw new MongooseError('Positional operators ($) are not supported in updates');
      target.set(path, castUpdateValue(path, value));
    }
  };

  collect(operators.$set, ops.set);
  collect(operators.$setOnInsert, ops.setOnInsert);
  for (const path of Object.keys(operators.$unset)) {
    if (path !== '_id' && schema.hasPath(path)) ops.unset.add(path);
  }
  for (const [path, value] of Object.entries(operators.$inc)) {
    if (schema.hasPath(path)) ops.inc.set(path, castScalar('Number', value, path));
  }

  const ts = schema.timestampPaths;
  if (ts && options.timestamps !== false) {
    const now = new Date();
    if (ts.updatedAt && !ops.set.has(ts.updatedAt)) ops.set.set(ts.updatedAt, now);
    if (options.upsert && ts.createdAt && !ops.set.has(ts.createdAt) && !ops.setOnInsert.has(ts.createdAt)) {
      ops.setOnInsert.set(ts.createdAt, now);
    }
  }
  return ops;
}

/** SQL expression for the new value of `doc`, with its bound parameters. */
function buildExpression(ops) {
  const params = [];
  const pairs = [];
  for (const [path, value] of ops.set) {
    pairs.push('?', 'json(?)');
    params.push(toJsonPath(path), JSON.stringify(value === undefined ? null : value));
  }
  for (const [path, amount] of ops.inc) {
    const jsonPath = toJsonPath(path);
    pairs.push('?', 'COALESCE(json_extract(doc, ?), 0) + ?');
    params.push(jsonPath, jsonPath, amount);
  }
  let expr = pairs.length ? `json_set(doc, ${pairs.join(', ')})` : 'doc';
  if (ops.unset.size) {
    const list = [...ops.unset];
    expr = `json_remove(${expr}, ${list.map(() => '?').join(', ')})`;
    params.push(...list.map(toJsonPath));
  }
  return { expr, params, changes: pairs.length > 0 || ops.unset.size > 0 };
}

/** json_set cannot create intermediate objects, so create missing parents first. */
function ancestorPaths(ops) {
  const out = new Set();
  const consider = (path) => {
    const parts = path.split('.');
    for (let i = 1; i < parts.length; i += 1) {
      if (/^\d+$/.test(parts[i])) break;
      out.add(parts.slice(0, i).join('.'));
    }
  };
  for (const p of ops.set.keys()) consider(p);
  for (const p of ops.inc.keys()) consider(p);
  return [...out].sort((a, b) => a.split('.').length - b.split('.').length);
}

function ensureParentStatement(collection, ancestor, where, whereParams) {
  return {
    sql: `UPDATE ${quote(collection)} SET doc = json_set(doc, ?, json('{}')) WHERE ${where} AND json_type(doc, ?) IS NOT 'object'`,
    args: [toJsonPath(ancestor), ...whereParams, toJsonPath(ancestor)],
  };
}

function valuesOf(ops) {
  const out = {};
  for (const [path, value] of ops.set) setPath(out, path, value);
  return out;
}

function collectEqualities(filter, base) {
  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith('$') || value instanceof RegExp || value === null || value === undefined) continue;
    if (isPlainObject(value)) {
      if (Object.prototype.hasOwnProperty.call(value, '$eq')) setPath(base, key, value.$eq);
      continue;
    }
    setPath(base, key, value);
  }
}

async function execUpdate(q, attempt = 0) {
  const Model = q.model;
  const { schema, collectionName: coll, db } = Model;
  await db.ensureModel(Model);

  const options = q._options || {};
  const filter = normalizeFilter(schema, q._filter, Model.modelName);
  const ops = parseUpdate(Model, q._update, options);
  const upsert = !!options.upsert;
  const returnNew = options.new === true || options.returnDocument === 'after';
  const isMany = q.op === 'updateMany';
  const isFind = q.op === 'findOneAndUpdate';

  const { rest, geo } = extractGeo(filter);
  const translated = translateFilter(schema, rest);

  // Which documents are targeted: either an exact SQL WHERE (updateMany) or a list of ids.
  let groups;
  let noMatch = false;
  if (isMany && translated.exact && !geo) {
    groups = [{ where: translated.frag ? translated.frag.sql : '1', params: translated.frag ? translated.frag.params : [] }];
  } else {
    const raws = await fetchRaw(Model, filter, { sort: q._sort, limit: isMany ? null : 1 });
    const ids = raws.map((r) => r._id);
    noMatch = ids.length === 0;
    groups = chunk(ids, 400).map((c) => ({ where: `_id IN (${c.map(() => '?').join(', ')})`, params: c }));
  }

  /* ----- upsert: nothing matched ----- */
  if (noMatch && upsert) {
    const base = {};
    collectEqualities(filter, base);
    for (const [p, v] of ops.setOnInsert) setPath(base, p, v);
    for (const [p, v] of ops.set) setPath(base, p, v);
    for (const [p, n] of ops.inc) setPath(base, p, (getPath(base, p) || 0) + n);
    for (const p of ops.unset) unsetPath(base, p);

    const finalDoc = {};
    castInto(schema, finalDoc, base, null);
    applyDefaults(schema, finalDoc);
    ensureNested(schema, finalDoc);

    const id = finalDoc._id;
    const data = minimize(deepClone(finalDoc));
    delete data._id;

    const exact = translated.exact && !geo;
    let sql;
    let args;
    if (exact) {
      sql = `INSERT INTO ${quote(coll)} (_id, doc) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${quote(coll)}${
        translated.frag ? ` WHERE ${translated.frag.sql}` : ''
      })`;
      args = [id, JSON.stringify(data), ...(translated.frag ? translated.frag.params : [])];
    } else {
      sql = `INSERT INTO ${quote(coll)} (_id, doc) VALUES (?, ?)`;
      args = [id, JSON.stringify(data)];
    }

    let result;
    try {
      result = await db.execute(sql, args);
    } catch (error) {
      throw db.mapError(error, coll, finalDoc);
    }

    if (result.rowsAffected === 0 && attempt < 3) return execUpdate(q, attempt + 1); // lost a race: update the winner

    if (isFind) {
      if (!returnNew) return null;
      const raw = JSON.parse(JSON.stringify({ _id: id, ...data }));
      return (await finalize(Model, [raw], q))[0];
    }
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: id };
  }

  if (noMatch || groups.length === 0) {
    if (isFind) return null;
    return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
  }

  const { expr, params: exprParams, changes } = buildExpression(ops);
  const parents = ancestorPaths(ops);

  /* ----- findOneAndUpdate / updateOne: exactly one target ----- */
  if (!isMany) {
    const id = groups[0].params[0];
    const where = '_id = ?';
    const stmts = [];
    let readIndex = -1;
    const selectSql = `SELECT _id, doc FROM ${quote(coll)} WHERE _id = ?`;

    if (isFind && !returnNew) {
      readIndex = stmts.length;
      stmts.push({ sql: selectSql, args: [id] });
    }
    for (const parent of parents) stmts.push(ensureParentStatement(coll, parent, where, [id]));
    if (changes) stmts.push({ sql: `UPDATE ${quote(coll)} SET doc = ${expr} WHERE ${where}`, args: [...exprParams, id] });
    if (isFind && returnNew) {
      readIndex = stmts.length;
      stmts.push({ sql: selectSql, args: [id] });
    }

    let results = [];
    try {
      if (stmts.length) results = await db.batch(stmts);
    } catch (error) {
      throw db.mapError(error, coll, valuesOf(ops));
    }

    if (isFind) {
      const row = results[readIndex] && results[readIndex].rows[0];
      return row ? (await finalize(Model, [rowToRaw(row)], q))[0] : null;
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: changes ? 1 : 0, upsertedCount: 0, upsertedId: null };
  }

  /* ----- updateMany ----- */
  let matched = 0;
  for (const group of groups) {
    const stmts = parents.map((p) => ensureParentStatement(coll, p, group.where, group.params));
    if (changes) stmts.push({ sql: `UPDATE ${quote(coll)} SET doc = ${expr} WHERE ${group.where}`, args: [...exprParams, ...group.params] });
    if (stmts.length === 0) continue;
    let results;
    try {
      results = await db.batch(stmts);
    } catch (error) {
      throw db.mapError(error, coll, valuesOf(ops));
    }
    if (changes) matched += results[results.length - 1].rowsAffected;
  }
  return { acknowledged: true, matchedCount: matched, modifiedCount: matched, upsertedCount: 0, upsertedId: null };
}

async function execDelete(q) {
  const Model = q.model;
  const { schema, collectionName: coll, db } = Model;
  await db.ensureModel(Model);

  const filter = normalizeFilter(schema, q._filter, Model.modelName);
  const { rest, geo } = extractGeo(filter);
  const translated = translateFilter(schema, rest);

  if (q.op === 'deleteMany') {
    if (translated.exact && !geo) {
      const result = await db.execute(
        `DELETE FROM ${quote(coll)}${translated.frag ? ` WHERE ${translated.frag.sql}` : ''}`,
        translated.frag ? translated.frag.params : []
      );
      return { acknowledged: true, deletedCount: result.rowsAffected };
    }
    const raws = await fetchRaw(Model, filter);
    let deleted = 0;
    for (const ids of chunk(raws.map((r) => r._id), 400)) {
      const result = await db.execute(`DELETE FROM ${quote(coll)} WHERE _id IN (${ids.map(() => '?').join(', ')})`, ids);
      deleted += result.rowsAffected;
    }
    return { acknowledged: true, deletedCount: deleted };
  }

  const [target] = await fetchRaw(Model, filter, { sort: q._sort, limit: 1 });
  if (!target) return q.op === 'deleteOne' ? { acknowledged: true, deletedCount: 0 } : null;
  const result = await db.execute(`DELETE FROM ${quote(coll)} WHERE _id = ?`, [target._id]);
  if (q.op === 'deleteOne') return { acknowledged: true, deletedCount: result.rowsAffected };
  return (await finalize(Model, [target], q))[0];
}

module.exports = { execUpdate, execDelete, parseUpdate };
