'use strict';

/**
 * Schema definition: parses the same definition syntax the models already use
 * (`{ field: String }`, `{ field: { type: Number, default: 0, min: 0 } }`, nested objects,
 * arrays of primitives, arrays of sub-documents, `Schema.Types.ObjectId`, `Schema.Types.Mixed`)
 * into flat path descriptors used for casting, defaults, validation and index creation.
 */

const { isPlainObject } = require('./util');
const { ObjectId } = require('./objectid');

function ObjectIdType() {}
function MixedType() {}

const TYPE_BY_FUNCTION = new Map([
  [String, 'String'],
  [Number, 'Number'],
  [Boolean, 'Boolean'],
  [Date, 'Date'],
  [Object, 'Mixed'],
  [Array, 'Array'],
  [ObjectIdType, 'ObjectId'],
  [ObjectId, 'ObjectId'],
  [MixedType, 'Mixed'],
]);

const TYPE_BY_NAME = {
  string: 'String',
  number: 'Number',
  boolean: 'Boolean',
  bool: 'Boolean',
  date: 'Date',
  objectid: 'ObjectId',
  mixed: 'Mixed',
  object: 'Mixed',
  array: 'Array',
};

function resolveTypeName(type) {
  if (typeof type === 'function') return TYPE_BY_FUNCTION.get(type) || null;
  if (typeof type === 'string') return TYPE_BY_NAME[type.toLowerCase()] || null;
  if (isPlainObject(type) && Object.keys(type).length === 0) return 'Mixed';
  return null;
}

function pair(option) {
  return Array.isArray(option) ? [option[0], option[1]] : [option, undefined];
}

function fillTemplate(template, vars) {
  return String(template).replace(/\{([A-Z]+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

/** Describes one schema path (a scalar, an array of scalars, or an array of sub-documents). */
class PathDescriptor {
  constructor(path, kind, options = {}) {
    this.path = path;
    this.kind = kind; // String | Number | Boolean | Date | ObjectId | Mixed | Array | DocumentArray
    this.options = options;
    this.caster = null; // element descriptor for arrays of scalars
    this.schema = null; // child schema for arrays of sub-documents
    this.ref = options.ref || null;
    this.selectByDefault = options.select !== false;

    this.hasDefault = false;
    this.defaultValue = undefined;
    if (Object.prototype.hasOwnProperty.call(options, 'default') && options.default !== undefined) {
      this.hasDefault = true;
      this.defaultValue = options.default;
    }

    this.required = null;
    if (options.required) {
      const [flag, message] = pair(options.required);
      if (flag) {
        this.required = {
          condition: typeof flag === 'function' ? flag : null,
          message: message || `Path \`${path}\` is required.`,
        };
      }
    }

    this.transforms = {
      trim: options.trim === true,
      lowercase: options.lowercase === true,
      uppercase: options.uppercase === true,
    };
    this.validators = [];
  }

  isArray() {
    return this.kind === 'Array' || this.kind === 'DocumentArray';
  }

  getDefault(doc) {
    const value = this.defaultValue;
    if (typeof value === 'function') return value.call(doc);
    if (Array.isArray(value)) return value.slice();
    if (isPlainObject(value)) return { ...value };
    return value;
  }
}

function buildValidators(desc) {
  const o = desc.options;
  const p = desc.path;
  const out = [];

  if (o.enum !== undefined && (desc.kind === 'String' || desc.kind === 'Number')) {
    const values = Array.isArray(o.enum) ? o.enum : o.enum && o.enum.values ? o.enum.values : Object.values(o.enum);
    const custom = !Array.isArray(o.enum) && o.enum && o.enum.message;
    out.push({
      type: 'enum',
      test: (v) => v === undefined || values.includes(v),
      message: (v) => (custom ? fillTemplate(custom, { PATH: p, VALUE: v }) : `\`${v}\` is not a valid enum value for path \`${p}\`.`),
    });
  }

  if (o.min !== undefined && (desc.kind === 'Number' || desc.kind === 'Date')) {
    const [min, msg] = pair(o.min);
    out.push({
      type: 'min',
      test: (v) => v === null || v === undefined || v >= min,
      message: (v) => fillTemplate(msg || 'Path `{PATH}` ({VALUE}) is less than minimum allowed value ({MIN}).', { PATH: p, VALUE: v, MIN: min }),
    });
  }
  if (o.max !== undefined && (desc.kind === 'Number' || desc.kind === 'Date')) {
    const [max, msg] = pair(o.max);
    out.push({
      type: 'max',
      test: (v) => v === null || v === undefined || v <= max,
      message: (v) => fillTemplate(msg || 'Path `{PATH}` ({VALUE}) is more than maximum allowed value ({MAX}).', { PATH: p, VALUE: v, MAX: max }),
    });
  }

  if (o.minlength !== undefined && desc.kind === 'String') {
    const [min, msg] = pair(o.minlength);
    out.push({
      type: 'minlength',
      test: (v) => v === null || v === undefined || String(v).length >= min,
      message: (v) =>
        fillTemplate(msg || 'Path `{PATH}` (`{VALUE}`) is shorter than the minimum allowed length ({MINLENGTH}).', { PATH: p, VALUE: v, MINLENGTH: min }),
    });
  }
  if (o.maxlength !== undefined && desc.kind === 'String') {
    const [max, msg] = pair(o.maxlength);
    out.push({
      type: 'maxlength',
      test: (v) => v === null || v === undefined || String(v).length <= max,
      message: (v) =>
        fillTemplate(msg || 'Path `{PATH}` (`{VALUE}`) is longer than the maximum allowed length ({MAXLENGTH}).', { PATH: p, VALUE: v, MAXLENGTH: max }),
    });
  }

  if (o.match && desc.kind === 'String') {
    const [regex, msg] = pair(o.match);
    out.push({
      type: 'regexp',
      test: (v) => {
        regex.lastIndex = 0;
        return v !== null && v !== undefined && v !== '' ? regex.test(v) : true;
      },
      message: (v) => fillTemplate(msg || 'Path `{PATH}` is invalid ({VALUE}).', { PATH: p, VALUE: v }),
    });
  }

  if (o.validate) {
    const list = Array.isArray(o.validate) && typeof o.validate[0] !== 'function' && !Array.isArray(o.validate[0]) && isPlainObject(o.validate[0])
      ? o.validate
      : [o.validate];
    for (const item of list) {
      let validator;
      let message;
      if (typeof item === 'function') validator = item;
      else if (Array.isArray(item)) [validator, message] = item;
      else if (item && typeof item === 'object') ({ validator, message } = item);
      if (typeof validator !== 'function') continue;
      out.push({
        type: 'user defined',
        test: validator,
        message: (v) => fillTemplate(message || 'Validator failed for path `{PATH}` with value `{VALUE}`', { PATH: p, VALUE: v }),
      });
    }
  }

  return out;
}

class VirtualType {
  constructor(name) {
    this.path = name;
    this.getters = [];
    this.setters = [];
  }

  get(fn) {
    this.getters.push(fn);
    return this;
  }

  set(fn) {
    this.setters.push(fn);
    return this;
  }
}

class Schema {
  constructor(definition = {}, options = {}) {
    this.options = { strict: true, minimize: true, _id: true, timestamps: false, ...options };
    this.paths = new Map(); // flat path -> PathDescriptor
    this.nested = new Set(); // paths that only group other paths
    this.methods = {};
    this.statics = {};
    this.virtuals = new Map();
    this.hooks = { pre: new Map(), post: new Map() };
    this.indexes = []; // { fields, options }
    this.timestampPaths = null;

    this.add(definition);

    if (this.options.timestamps) {
      const ts = this.options.timestamps;
      const createdAt = ts === true || ts.createdAt !== false ? (typeof ts.createdAt === 'string' ? ts.createdAt : 'createdAt') : null;
      const updatedAt = ts === true || ts.updatedAt !== false ? (typeof ts.updatedAt === 'string' ? ts.updatedAt : 'updatedAt') : null;
      this.timestampPaths = { createdAt, updatedAt };
      for (const p of [createdAt, updatedAt]) {
        if (p && !this.paths.has(p)) this._register(new PathDescriptor(p, 'Date', {}));
      }
    }

    if (this.options._id !== false && !this.paths.has('_id')) {
      const idDesc = new PathDescriptor('_id', 'ObjectId', {});
      idDesc.auto = true;
      this.paths.set('_id', idDesc);
    }

    this._collectFieldIndexes();
  }

  add(definition, prefix = '') {
    for (const key of Object.keys(definition)) {
      this._addPath(prefix ? `${prefix}.${key}` : key, definition[key]);
    }
    return this;
  }

  _addPath(path, def) {
    if (Array.isArray(def)) return this._addArray(path, def, {});

    if (isPlainObject(def)) {
      if (def.type !== undefined) {
        const typeIsNestedField = isPlainObject(def.type) && def.type.type !== undefined;
        if (!typeIsNestedField) return this._addTyped(path, def.type, def);
        this.nested.add(path);
        return this.add(def, path);
      }
      if (Object.keys(def).length === 0) return this._register(new PathDescriptor(path, 'Mixed', {}));
      this.nested.add(path);
      return this.add(def, path);
    }

    return this._addTyped(path, def, {});
  }

  _addTyped(path, type, options) {
    if (Array.isArray(type)) return this._addArray(path, type, options);
    if (type === Array) return this._addArray(path, [], options);
    if (type instanceof Schema) throw new Error(`Single nested schemas are not supported (path "${path}")`);
    const kind = resolveTypeName(type);
    if (!kind) throw new Error(`Invalid schema configuration: unknown type for path "${path}"`);
    return this._register(new PathDescriptor(path, kind, options));
  }

  _addArray(path, def, options) {
    const cast = def[0];
    let desc;

    if (cast === undefined) {
      desc = new PathDescriptor(path, 'Array', options);
      desc.caster = new PathDescriptor(path, 'Mixed', {});
    } else if (isPlainObject(cast)) {
      const typedElement = cast.type !== undefined && !(isPlainObject(cast.type) && cast.type.type !== undefined);
      if (typedElement) {
        desc = new PathDescriptor(path, 'Array', options);
        const kind = resolveTypeName(cast.type);
        if (!kind) throw new Error(`Invalid schema configuration: unknown array element type for path "${path}"`);
        desc.caster = new PathDescriptor(path, kind, cast);
      } else if (Object.keys(cast).length === 0) {
        desc = new PathDescriptor(path, 'Array', options);
        desc.caster = new PathDescriptor(path, 'Mixed', {});
      } else {
        desc = new PathDescriptor(path, 'DocumentArray', options);
        desc.schema = new Schema(cast, { _id: cast._id !== false });
      }
    } else {
      desc = new PathDescriptor(path, 'Array', options);
      const kind = resolveTypeName(cast);
      if (!kind) throw new Error(`Invalid schema configuration: unknown array element type for path "${path}"`);
      desc.caster = new PathDescriptor(path, kind, {});
    }

    return this._register(desc);
  }

  _register(desc) {
    desc.validators = buildValidators(desc);
    if (desc.caster) desc.caster.validators = buildValidators(desc.caster);
    if (desc.isArray() && !desc.hasDefault) {
      desc.hasDefault = true;
      desc.defaultValue = () => [];
    }
    this.paths.set(desc.path, desc);
    return this;
  }

  _collectFieldIndexes() {
    for (const [path, desc] of this.paths) {
      if (path === '_id' || desc.isArray() || desc.kind === 'Mixed') continue;
      const o = desc.options;
      if (o.unique) {
        this.indexes.push({ fields: { [path]: 1 }, options: { unique: true, sparse: !!o.sparse } });
      } else if (o.index === true) {
        this.indexes.push({ fields: { [path]: 1 }, options: {} });
      }
    }
  }

  index(fields, options = {}) {
    this.indexes.push({ fields, options });
    return this;
  }

  virtual(name) {
    if (!this.virtuals.has(name)) this.virtuals.set(name, new VirtualType(name));
    return this.virtuals.get(name);
  }

  pre(name, ...args) {
    const fn = args[args.length - 1];
    if (!this.hooks.pre.has(name)) this.hooks.pre.set(name, []);
    this.hooks.pre.get(name).push(fn);
    return this;
  }

  post(name, ...args) {
    const fn = args[args.length - 1];
    if (!this.hooks.post.has(name)) this.hooks.post.set(name, []);
    this.hooks.post.get(name).push(fn);
    return this;
  }

  plugin(fn, options) {
    fn(this, options);
    return this;
  }

  set(key, value) {
    this.options[key] = value;
    return this;
  }

  path(name) {
    return this.paths.get(name);
  }

  /** True for paths a user may legitimately set (used to strip unknown paths like Mongoose's strict mode). */
  hasPath(path) {
    if (this.paths.has(path) || this.nested.has(path)) return true;
    const parts = path.split('.');
    for (let i = 1; i < parts.length; i += 1) {
      const prefix = parts.slice(0, i).join('.');
      const desc = this.paths.get(prefix);
      if (!desc || !desc.isArray()) continue;
      let rest = parts.slice(i);
      if (rest.length && (/^\d+$/.test(rest[0]) || rest[0] === '$')) rest = rest.slice(1);
      if (desc.kind === 'DocumentArray') return rest.length === 0 || desc.schema.hasPath(rest.join('.'));
      return rest.length === 0;
    }
    return false;
  }

  /** Paths that hold a reference to another model: [{ path, ref }] (top level only). */
  refPaths() {
    const out = [];
    for (const [path, desc] of this.paths) {
      if (desc.ref) out.push({ path, ref: desc.ref });
      else if (desc.kind === 'Array' && desc.caster && desc.caster.ref) out.push({ path, ref: desc.caster.ref });
    }
    return out;
  }
}

Schema.Types = {
  ObjectId: ObjectIdType,
  Mixed: MixedType,
  String,
  Number,
  Boolean,
  Date,
  Array,
};

module.exports = { Schema, PathDescriptor, VirtualType, fillTemplate };
