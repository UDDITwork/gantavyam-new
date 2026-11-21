'use strict';

/**
 * Document and Model: the Mongoose-style API (new Model(), save(), find(), populate(), hooks,
 * virtuals, methods/statics) on top of the libSQL JSON-document store.
 */

const { castInto, castPath, applyDefaults, ensureNested, reviveDates, validateObject } = require('./cast');
const { Selection } = require('./projection');
const { runPre, runPost } = require('./hooks');
const { ValidationError, DocumentNotFoundError } = require('./errors');
const { quote } = require('./client');
const { Query, normalizePopulate } = require('./query');
const { Aggregate } = require('./aggregate');
const { eachSlot, populateResults } = require('./fetch');
const { isPlainObject, isDocument, getPath, setPath, deepClone, minimize, diffObjects, toJsonPath, chunk } = require('./util');
const { setValue } = require('./cast');

function pluralize(name) {
  const lower = name.toLowerCase();
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

function hidden(value) {
  return { value, writable: true, enumerable: false, configurable: true };
}

function initInternals(doc) {
  Object.defineProperties(doc, {
    _doc: hidden({}),
    _snapshot: hidden(null),
    _castErrors: hidden({}),
    _directModified: hidden(new Set()),
    _populatedPaths: hidden(new Set()),
    _selection: hidden(null),
    isNew: hidden(true),
  });
}

class Document {
  constructor(obj, options = {}) {
    initInternals(this);
    if (options.skipInit) return;
    const { schema } = this.constructor;
    const source = isDocument(obj) ? obj.toObject() : obj;
    if (isPlainObject(source)) {
      castInto(schema, this._doc, source, this._castErrors);
      this._markProvided(source);
    }
    applyDefaults(schema, this._doc);
    ensureNested(schema, this._doc);
  }

  _markProvided(source, prefix = '') {
    const { schema } = this.constructor;
    for (const key of Object.keys(source)) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (schema.paths.has(full)) this._directModified.add(full);
      else if (schema.nested.has(full) && isPlainObject(source[key])) this._markProvided(source[key], full);
    }
  }

  /* ------------------------------------------------------------ values */

  get(path) {
    const { schema } = this.constructor;
    if (schema.virtuals.has(path)) return this[path];
    return getPath(this._doc, path);
  }

  set(path, value) {
    if (isPlainObject(path)) {
      for (const key of Object.keys(path)) this.set(key, path[key]);
      return this;
    }
    const { schema } = this.constructor;
    delete this._castErrors[path];

    if (value === undefined) {
      const parts = path.split('.');
      let cur = this._doc;
      for (let i = 0; i < parts.length - 1 && cur; i += 1) cur = cur[parts[i]];
      if (cur) delete cur[parts[parts.length - 1]];
      if (schema.nested.has(path)) setPath(this._doc, path, {});
      this._directModified.add(path);
      return this;
    }

    if (setValue(schema, this._doc, path, value, this._castErrors)) this._directModified.add(path);
    return this;
  }

  /* ------------------------------------------------------------ change tracking */

  _storable() {
    const out = deepClone(this._doc);
    delete out._id;
    if (this._populatedPaths.size) this._depopulate(out);
    return minimize(out);
  }

  _depopulate(obj) {
    for (const path of this._populatedPaths) {
      eachSlot(obj, path.split('.'), 0, (container, key) => {
        const value = container[key];
        if (Array.isArray(value)) container[key] = value.map((v) => (v && typeof v === 'object' ? v._id : v));
        else if (value && typeof value === 'object') container[key] = value._id;
      });
    }
  }

  _diff() {
    return diffObjects(this._snapshot || {}, this._storable());
  }

  isModified(path) {
    let changed;
    if (this.isNew) {
      changed = [...this._directModified];
    } else {
      const diff = this._diff();
      changed = [...diff.sets.keys(), ...diff.unsets];
    }
    if (!path) return changed.length > 0;
    return changed.some((p) => p === path || p.startsWith(`${path}.`) || path.startsWith(`${p}.`));
  }

  modifiedPaths() {
    if (this.isNew) return [...this._directModified];
    const diff = this._diff();
    return [...diff.sets.keys(), ...diff.unsets];
  }

  markModified(path) {
    if (this.isNew) this._directModified.add(path);
  }

  isSelected(path) {
    return !this._selection || this._selection.isSelected(path);
  }

  /* ------------------------------------------------------------ output */

  _toPlain(json, options = {}) {
    const out = minimize(deepClone(this._doc, json));
    const ordered = out._id !== undefined ? { _id: out._id, ...out } : out;
    if (options.virtuals) {
      const { schema } = this.constructor;
      for (const name of schema.virtuals.keys()) ordered[name] = this[name];
      if (!schema.paths.has('id') && !schema.virtuals.has('id')) ordered.id = String(this._doc._id);
    }
    return ordered;
  }

  toObject(options) {
    return this._toPlain(false, options);
  }

  toJSON(options) {
    return this._toPlain(true, options);
  }

  equals(other) {
    return !!other && String(other._id) === String(this._id);
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toObject();
  }

  /* ------------------------------------------------------------ persistence */

  _shouldCheckRequired(path) {
    if (this.isNew || !this._selection) return true;
    return this._selection.isSelected(path) || this.isModified(path);
  }

  /** Re-casts arrays and sub-documents so pushed raw objects get defaults, ids and cast values. */
  _normalize() {
    const { schema } = this.constructor;
    for (const [path, desc] of schema.paths) {
      if (desc.kind !== 'Array' && desc.kind !== 'DocumentArray') continue;
      if ([...this._populatedPaths].some((p) => p === path || p.startsWith(`${path}.`))) continue;
      const value = getPath(this._doc, path);
      if (value === undefined || value === null) continue;
      setPath(this._doc, path, castPath(desc, value, this._castErrors, path));
    }
  }

  async validate() {
    const Model = this.constructor;
    const errors = { ...this._castErrors };
    await validateObject(Model.schema, this._doc, { doc: this, shouldCheckRequired: (p) => this._shouldCheckRequired(p) }, '', errors);
    const paths = Object.keys(errors);
    if (paths.length) {
      const error = new ValidationError(Model.modelName);
      for (const p of paths) error.addError(p, errors[p]);
      throw error;
    }
  }

  async save(options = {}) {
    const Model = this.constructor;
    const { schema, db } = Model;
    await db.ensureModel(Model);

    this._normalize();
    if (options.validateBeforeSave !== false && schema.options.validateBeforeSave !== false) await this.validate();
    await runPre(schema.hooks.pre.get('save'), this, [options]);
    this._normalize();

    const now = new Date();
    if (this.isNew) {
      const ts = schema.timestampPaths;
      if (ts) {
        if (ts.createdAt && this._doc[ts.createdAt] === undefined) this._doc[ts.createdAt] = now;
        if (ts.updatedAt && this._doc[ts.updatedAt] === undefined) this._doc[ts.updatedAt] = now;
      }
      await this._insert();
    } else {
      await this._persistChanges(now);
    }

    await runPost(schema.hooks.post.get('save'), this, [this]);
    return this;
  }

  async _insert() {
    const { db, collectionName } = this.constructor;
    const data = this._storable();
    try {
      await db.execute(`INSERT INTO ${quote(collectionName)} (_id, doc) VALUES (?, ?)`, [this._doc._id, JSON.stringify(data)]);
    } catch (error) {
      throw db.mapError(error, collectionName, this._doc);
    }
    this.isNew = false;
    this._snapshot = data;
    this._directModified.clear();
    this._selection = null;
  }

  async _persistChanges(now) {
    const Model = this.constructor;
    const { db, collectionName, schema } = Model;

    let current = this._storable();
    let diff = diffObjects(this._snapshot || {}, current);
    if (diff.sets.size === 0 && diff.unsets.size === 0) return;

    const ts = schema.timestampPaths;
    if (ts && ts.updatedAt && !diff.sets.has(ts.updatedAt)) {
      this._doc[ts.updatedAt] = now;
      current = this._storable();
      diff = diffObjects(this._snapshot || {}, current);
    }

    const params = [];
    const pairs = [];
    for (const [path, value] of diff.sets) {
      pairs.push('?', 'json(?)');
      params.push(toJsonPath(path), JSON.stringify(value));
    }
    let expr = pairs.length ? `json_set(doc, ${pairs.join(', ')})` : 'doc';
    if (diff.unsets.size) {
      const list = [...diff.unsets];
      expr = `json_remove(${expr}, ${list.map(() => '?').join(', ')})`;
      params.push(...list.map(toJsonPath));
    }
    params.push(this._doc._id);

    let result;
    try {
      result = await db.execute(`UPDATE ${quote(collectionName)} SET doc = ${expr} WHERE _id = ?`, params);
    } catch (error) {
      throw db.mapError(error, collectionName, this._doc);
    }
    if (result.rowsAffected === 0) throw new DocumentNotFoundError({ _id: this._doc._id }, Model.modelName);

    this._snapshot = current;
    this._directModified.clear();
  }

  async deleteOne() {
    await this.constructor.deleteOne({ _id: this._doc._id });
    return this;
  }

  remove() {
    return this.deleteOne();
  }

  async populate(...args) {
    await populateResults(this.constructor, [this], normalizePopulate(args), false);
    return this;
  }

  /* ------------------------------------------------------------ static API */

  static find(filter, projection, options) {
    const q = new Query(this, 'find').merge(filter);
    if (projection) q.select(projection);
    if (options) q.setOptions(options);
    return q;
  }

  static findOne(filter, projection, options) {
    const q = new Query(this, 'findOne').merge(filter);
    if (projection) q.select(projection);
    if (options) q.setOptions(options);
    return q;
  }

  static findById(id, projection, options) {
    return this.findOne({ _id: id }, projection, options);
  }

  static countDocuments(filter) {
    return new Query(this, 'countDocuments').merge(filter);
  }

  static estimatedDocumentCount() {
    return new Query(this, 'estimatedDocumentCount');
  }

  static distinct(field, filter) {
    const q = new Query(this, 'distinct').merge(filter);
    q._field = field;
    return q;
  }

  static exists(filter) {
    return new Query(this, 'findOne').merge(filter).select('_id').lean();
  }

  static findOneAndUpdate(filter, update, options) {
    const q = new Query(this, 'findOneAndUpdate').merge(filter);
    q._update = update;
    if (options) q.setOptions(options);
    return q;
  }

  static findByIdAndUpdate(id, update, options) {
    return this.findOneAndUpdate({ _id: id }, update, options);
  }

  static updateOne(filter, update, options) {
    const q = new Query(this, 'updateOne').merge(filter);
    q._update = update;
    if (options) q.setOptions(options);
    return q;
  }

  static updateMany(filter, update, options) {
    const q = new Query(this, 'updateMany').merge(filter);
    q._update = update;
    if (options) q.setOptions(options);
    return q;
  }

  static findOneAndDelete(filter, options) {
    const q = new Query(this, 'findOneAndDelete').merge(filter);
    if (options) q.setOptions(options);
    return q;
  }

  static findByIdAndDelete(id, options) {
    return this.findOneAndDelete({ _id: id }, options);
  }

  static deleteOne(filter) {
    return new Query(this, 'deleteOne').merge(filter);
  }

  static deleteMany(filter) {
    return new Query(this, 'deleteMany').merge(filter);
  }

  static aggregate(pipeline) {
    return new Aggregate(this, pipeline);
  }

  static async create(docs, options) {
    const many = Array.isArray(docs);
    const created = [];
    for (const input of many ? docs : [docs]) {
      const doc = new this(input);
      await doc.save(options);
      created.push(doc);
    }
    return many ? created : created[0];
  }

  static async insertMany(docs, options = {}) {
    const Model = this;
    const { schema, db, collectionName } = Model;
    await db.ensureModel(Model);

    const list = Array.isArray(docs) ? docs : [docs];
    await runPre(schema.hooks.pre.get('insertMany'), Model, [list]);

    const ordered = options.ordered !== false;
    const created = [];
    for (const input of list) {
      const doc = new Model(input);
      try {
        doc._normalize();
        await doc.validate();
        const ts = schema.timestampPaths;
        const now = new Date();
        if (ts) {
          if (ts.createdAt && doc._doc[ts.createdAt] === undefined) doc._doc[ts.createdAt] = now;
          if (ts.updatedAt && doc._doc[ts.updatedAt] === undefined) doc._doc[ts.updatedAt] = now;
        }
        created.push(doc);
      } catch (error) {
        if (ordered) throw error;
      }
    }

    const statements = created.map((doc) => ({
      sql: `INSERT INTO ${quote(collectionName)} (_id, doc) VALUES (?, ?)`,
      args: [doc._doc._id, JSON.stringify(doc._storable())],
    }));
    for (const group of chunk(statements, 100)) {
      try {
        await db.batch(group);
      } catch (error) {
        throw db.mapError(error, collectionName, null);
      }
    }
    for (const doc of created) {
      doc.isNew = false;
      doc._snapshot = doc._storable();
      doc._directModified.clear();
    }
    return created;
  }

  static syncIndexes() {
    return this.db.ensureModel(this);
  }

  static createIndexes() {
    return this.db.ensureModel(this);
  }

  static ensureIndexes() {
    return this.db.ensureModel(this);
  }

  static init() {
    return this.db.ensureModel(this);
  }

  static model(name) {
    return this.db.models.get(name);
  }

  /** Builds a document from a raw stored object (internal; also used by lean=false queries). */
  static _hydrate(raw, selection) {
    const { schema } = this;
    const doc = Object.create(this.prototype);
    initInternals(doc);

    reviveDates(schema, raw);
    const restricted = selection && (selection.inclusion || selection.exclude.length > 0 || selection.defaultExcluded.length > 0);
    applyDefaults(schema, raw, restricted ? (p) => selection.isSelected(p) : null);
    ensureNested(schema, raw);

    doc._doc = raw;
    doc.isNew = false;
    doc._selection = restricted ? selection : null;
    doc._snapshot = doc._storable();
    return doc;
  }

  static hydrate(obj) {
    return this._hydrate(JSON.parse(JSON.stringify(obj)), new Selection(this.schema, null));
  }
}

function createModel(db, name, schema, collectionName) {
  class Model extends Document {}
  Object.defineProperty(Model, 'name', { value: name });
  Model.modelName = name;
  Model.schema = schema;
  Model.collectionName = collectionName;
  Model.db = db;

  Object.assign(Model.prototype, schema.methods);
  Object.assign(Model, schema.statics);

  const reserved = new Set(Object.getOwnPropertyNames(Document.prototype));
  const topLevel = new Set();
  for (const p of schema.paths.keys()) topLevel.add(p.split('.')[0]);
  for (const p of schema.nested) topLevel.add(p.split('.')[0]);

  for (const key of topLevel) {
    if (reserved.has(key) || Object.prototype.hasOwnProperty.call(schema.methods, key)) continue;
    Object.defineProperty(Model.prototype, key, {
      get() {
        return this._doc[key];
      },
      set(value) {
        this.set(key, value);
      },
      enumerable: false,
      configurable: true,
    });
  }

  for (const [virtualName, virtual] of schema.virtuals) {
    Object.defineProperty(Model.prototype, virtualName, {
      get() {
        return virtual.getters.reduce((acc, fn) => fn.call(this, acc, virtual, this), undefined);
      },
      set(value) {
        virtual.setters.forEach((fn) => fn.call(this, value, virtual, this));
      },
      enumerable: false,
      configurable: true,
    });
  }

  if (!topLevel.has('id') && !schema.virtuals.has('id')) {
    Object.defineProperty(Model.prototype, 'id', {
      get() {
        return this._doc._id === undefined ? undefined : String(this._doc._id);
      },
      enumerable: false,
      configurable: true,
    });
  }

  return Model;
}

module.exports = { Document, createModel, pluralize };
