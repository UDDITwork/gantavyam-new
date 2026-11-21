'use strict';

/** Chainable, thenable Query (find / findOne / count / update / delete ...). */

const { normalizeFilter } = require('./filter');
const { parseSelect, mergeSpecs } = require('./projection');
const { fetchRaw, countRaw, finalize } = require('./fetch');
const { isPlainObject, getPath } = require('./util');

function normalizeDirection(value) {
  return value === -1 || value === 'desc' || value === 'descending' ? -1 : 1;
}

function parseSort(arg) {
  const out = {};
  if (typeof arg === 'string') {
    for (const token of arg.split(/\s+/).filter(Boolean)) {
      if (token[0] === '-') out[token.slice(1)] = -1;
      else if (token[0] === '+') out[token.slice(1)] = 1;
      else out[token] = 1;
    }
  } else if (Array.isArray(arg)) {
    for (const entry of arg) {
      if (Array.isArray(entry)) out[entry[0]] = normalizeDirection(entry[1]);
      else if (typeof entry === 'string') Object.assign(out, parseSort(entry));
    }
  } else if (isPlainObject(arg)) {
    for (const [key, value] of Object.entries(arg)) out[key] = normalizeDirection(value);
  }
  return out;
}

function normalizePopulate(args) {
  const [first, second, third] = args;
  if (Array.isArray(first)) return first.flatMap((item) => normalizePopulate([item]));
  if (isPlainObject(first)) {
    return [{ path: first.path, select: first.select, populate: first.populate, model: first.model }];
  }
  if (typeof first === 'string') {
    const select = typeof second === 'string' || isPlainObject(second) ? second : undefined;
    return [{ path: first, select, model: third }];
  }
  return [];
}

class Query {
  constructor(model, op) {
    this.model = model;
    this.op = op;
    this._filter = {};
    this._select = null;
    this._sort = null;
    this._limit = null;
    this._skip = null;
    this._lean = false;
    this._populate = [];
    this._update = null;
    this._options = {};
    this._field = null; // distinct
  }

  merge(filter) {
    if (filter && typeof filter === 'object') this._filter = { ...this._filter, ...filter };
    return this;
  }

  select(arg) {
    this._select = mergeSpecs(this._select, parseSelect(arg));
    return this;
  }

  sort(arg) {
    this._sort = { ...(this._sort || {}), ...parseSort(arg) };
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  skip(n) {
    this._skip = n;
    return this;
  }

  lean(value = true) {
    this._lean = value !== false;
    return this;
  }

  populate(...args) {
    this._populate.push(...normalizePopulate(args));
    return this;
  }

  setOptions(options = {}) {
    for (const [key, value] of Object.entries(options)) {
      if (key === 'lean') this.lean(value);
      else if (key === 'sort') this.sort(value);
      else if (key === 'limit') this.limit(value);
      else if (key === 'skip') this.skip(value);
      else if (key === 'select') this.select(value);
      else if (key === 'populate') this.populate(value);
      else this._options[key] = value;
    }
    return this;
  }

  countDocuments(filter) {
    this.op = 'countDocuments';
    return this.merge(filter);
  }

  exec() {
    switch (this.op) {
      case 'find':
        return execFind(this, false);
      case 'findOne':
        return execFind(this, true);
      case 'countDocuments':
      case 'estimatedDocumentCount':
        return execCount(this);
      case 'distinct':
        return execDistinct(this);
      case 'findOneAndUpdate':
      case 'updateOne':
      case 'updateMany':
        return require('./update').execUpdate(this);
      case 'findOneAndDelete':
      case 'deleteOne':
      case 'deleteMany':
        return require('./update').execDelete(this);
      default:
        return Promise.reject(new Error(`Unsupported query operation: ${this.op}`));
    }
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

async function execFind(q, one) {
  const Model = q.model;
  await Model.db.ensureModel(Model);
  const filter = normalizeFilter(Model.schema, q._filter, Model.modelName);
  const raws = await fetchRaw(Model, filter, {
    sort: q._sort,
    limit: one ? 1 : q._limit,
    skip: q._skip,
  });
  const docs = await finalize(Model, raws, q);
  return one ? docs[0] || null : docs;
}

async function execCount(q) {
  const Model = q.model;
  await Model.db.ensureModel(Model);
  const filter = q.op === 'estimatedDocumentCount' ? {} : normalizeFilter(Model.schema, q._filter, Model.modelName);
  return countRaw(Model, filter);
}

async function execDistinct(q) {
  const Model = q.model;
  await Model.db.ensureModel(Model);
  const filter = normalizeFilter(Model.schema, q._filter, Model.modelName);
  const raws = await fetchRaw(Model, filter);
  const seen = new Map();
  for (const raw of raws) {
    const value = getPath(raw, q._field);
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v !== undefined && v !== null) seen.set(typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${v}`, v);
    }
  }
  return [...seen.values()];
}

module.exports = { Query, parseSort, normalizePopulate };
