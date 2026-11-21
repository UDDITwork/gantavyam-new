'use strict';

/**
 * Aggregation pipelines. Leading $match stages are pushed down to SQL as a pre-filter; the whole
 * pipeline is then executed in memory by mingo, which implements MongoDB's operators
 * ($group, $sum, $avg, $ifNull, $cond, $dateToString, $lookup, ...).
 */

const { Aggregator } = require('mingo');
const { normalizeFilter, translateFilter } = require('./filter');
const { quote } = require('./client');
const { reviveDates } = require('./cast');
const { rowToRaw } = require('./fetch');
const { ObjectId } = require('./objectid');
const { isPlainObject } = require('./util');

/** MongoDB's $week: week of the year, Sunday-based, days before the first Sunday are week 0. */
function weekExpression(dateExpr) {
  return {
    $floor: {
      $divide: [{ $subtract: [{ $add: [{ $dayOfYear: dateExpr }, 7] }, { $dayOfWeek: dateExpr }] }, 7],
    },
  };
}

/** Converts ObjectId instances to hex strings and rewrites operators mingo implements differently. */
function rewrite(value) {
  if (value instanceof ObjectId) return value.toHexString();
  if (Array.isArray(value)) return value.map(rewrite);
  if (value === null || value instanceof Date || value instanceof RegExp || !isPlainObject(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$week') return weekExpression(rewrite(value.$week));

  const out = {};
  for (const key of keys) out[key] = rewrite(value[key]);
  return out;
}

function lookupCollections(pipeline) {
  const names = new Set();
  const visit = (stage) => {
    if (stage && stage.$lookup && typeof stage.$lookup.from === 'string') names.add(stage.$lookup.from);
  };
  pipeline.forEach(visit);
  return [...names];
}

class Aggregate {
  constructor(model, pipeline = []) {
    this.model = model;
    this._pipeline = [...pipeline];
  }

  append(...stages) {
    this._pipeline.push(...stages.flat());
    return this;
  }

  match(filter) {
    return this.append({ $match: filter });
  }

  group(spec) {
    return this.append({ $group: spec });
  }

  sort(spec) {
    return this.append({ $sort: spec });
  }

  limit(n) {
    return this.append({ $limit: n });
  }

  project(spec) {
    return this.append({ $project: spec });
  }

  async exec() {
    const Model = this.model;
    const { schema, db, collectionName } = Model;
    await db.ensureModel(Model);

    const pipeline = rewrite(this._pipeline);

    // Pre-filter with the leading $match stages (they run again, exactly, inside mingo).
    const leading = [];
    for (const stage of pipeline) {
      if (isPlainObject(stage) && Object.keys(stage).length === 1 && stage.$match) leading.push(stage.$match);
      else break;
    }
    let sql = `SELECT _id, doc FROM ${quote(collectionName)}`;
    const params = [];
    if (leading.length) {
      const combined = leading.length === 1 ? leading[0] : { $and: leading };
      const { frag } = translateFilter(schema, normalizeFilter(schema, combined, Model.modelName));
      if (frag) {
        sql += ` WHERE ${frag.sql}`;
        params.push(...frag.params);
      }
    }
    sql += ' ORDER BY rowid ASC';

    const rows = (await db.execute(sql, params)).rows;
    const docs = rows.map(rowToRaw);
    docs.forEach((d) => reviveDates(schema, d));

    // $lookup needs the other collections up front because mingo resolves them synchronously
    const foreign = new Map();
    for (const name of lookupCollections(pipeline)) {
      const Other = [...db.models.values()].find((m) => m.collectionName === name);
      if (!Other) continue;
      await db.ensureModel(Other);
      const result = await db.execute(`SELECT _id, doc FROM ${quote(name)} ORDER BY rowid ASC`);
      const list = result.rows.map(rowToRaw);
      list.forEach((d) => reviveDates(Other.schema, d));
      foreign.set(name, list);
    }

    return new Aggregator(pipeline, { collectionResolver: (name) => foreign.get(name) || [] }).run(docs);
  }

  then(onFulfilled, onRejected) {
    return this.exec().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.exec().catch(onRejected);
  }

  finally(onFinally) {
    return this.exec().finally(onFinally);
  }
}

module.exports = { Aggregate };
