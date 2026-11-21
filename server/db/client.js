'use strict';

/**
 * Database connection (Turso / libSQL), table + index creation, TTL clean-up and error mapping.
 *
 * Every model is stored in one table:  <collection>(_id TEXT PRIMARY KEY, doc TEXT)
 * where `doc` holds the document as JSON. Indexes are SQLite expression indexes on json_extract().
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@libsql/client');
const { DuplicateKeyError } = require('./errors');
const { jsonExtract, SCALAR_KINDS } = require('./filter');
const { getPath } = require('./util');

const STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
  disconnected: 0,
  connected: 1,
  connecting: 2,
  disconnecting: 3,
  uninitialized: 99,
};

function quote(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function normalizeArg(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class Database {
  constructor() {
    this.client = null;
    this.readyState = 0;
    this.name = '';
    this.host = '';
    this.port = undefined;
    this.bufferTimeoutMs = 10000;
    this.models = new Map();

    this._readyPromise = null;
    this._resolveReady = null;
    this._ensured = new Map(); // collection -> Promise
    this._uniqueIndexes = new Map(); // sql index name -> { collection, fields }
    this._ttl = []; // { collection, path, seconds }
    this._sweeper = null;
    this._resetReady();
  }

  _resetReady() {
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
  }

  /**
   * connect({ url, authToken }) or connect(url, { authToken }).
   * `file:` URLs use a local SQLite file (development and tests); `libsql://` URLs talk to Turso.
   */
  async connect(urlOrOptions, maybeOptions = {}) {
    const options = typeof urlOrOptions === 'string' ? { ...maybeOptions, url: urlOrOptions } : { ...urlOrOptions };
    let url = options.url || process.env.TURSO_DATABASE_URL;
    const authToken = options.authToken || process.env.TURSO_AUTH_TOKEN;
    // Old maintenance scripts still pass a MongoDB connection string; use the Turso URL instead.
    if (url && /^mongodb(\+srv)?:\/\//i.test(url)) {
      console.warn('[db] Ignoring a MongoDB connection string: this project now uses Turso/libSQL. Using TURSO_DATABASE_URL.');
      url = process.env.TURSO_DATABASE_URL;
    }
    if (!url) throw new Error('No database URL given. Set TURSO_DATABASE_URL (libsql://... or file:...).');

    this.readyState = 2;

    if (url.startsWith('file:') && !url.startsWith('file::memory:')) {
      const filePath = url.slice('file:'.length);
      if (filePath && filePath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
    }

    // HTTP is more robust than a long-lived WebSocket on serverless platforms such as Cloud Run
    if (url.startsWith('libsql://') && options.transport !== 'websocket' && process.env.TURSO_TRANSPORT !== 'websocket') {
      url = `https://${url.slice('libsql://'.length)}`;
    }

    try {
      this.client = createClient({ url, authToken });
      await this.client.execute('SELECT 1');
    } catch (error) {
      this.readyState = 0;
      throw error;
    }

    try {
      const parsed = new URL(url.startsWith('file:') ? 'http://localhost' : url);
      this.host = url.startsWith('file:') ? 'local-file' : parsed.hostname;
    } catch (e) {
      this.host = 'unknown';
    }
    this.name = url.startsWith('file:') ? url.slice('file:'.length) : 'turso';

    this.readyState = 1;
    this._resolveReady();
    this._startSweeper();
    return this;
  }

  // Mongoose-style connection helpers used by existing code
  close() {
    return this.disconnect();
  }

  on() {
    return this;
  }

  once() {
    return this;
  }

  async disconnect() {
    this.readyState = 3;
    if (this._sweeper) clearInterval(this._sweeper);
    this._sweeper = null;
    if (this.client) this.client.close();
    this.client = null;
    this._ensured.clear();
    this.readyState = 0;
    this._resetReady();
  }

  /** Resolves once connected; rejects after the buffer timeout (like Mongoose's command buffering). */
  whenReady(label = 'operation') {
    if (this.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Operation \`${label}\` buffering timed out after ${this.bufferTimeoutMs}ms`));
      }, this.bufferTimeoutMs);
      this._readyPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async execute(sql, args = []) {
    await this.whenReady(sql.slice(0, 40));
    return this.client.execute({ sql, args: args.map(normalizeArg) });
  }

  /** Runs statements in one round trip, atomically. statements: [{ sql, args }] */
  async batch(statements) {
    await this.whenReady('batch');
    return this.client.batch(
      statements.map((s) => ({ sql: s.sql, args: (s.args || []).map(normalizeArg) })),
      'write'
    );
  }

  /** Creates the table and indexes for a model once. */
  ensureModel(Model) {
    const collection = Model.collectionName;
    if (!this._ensured.has(collection)) {
      this._ensured.set(
        collection,
        (async () => {
          await this.whenReady(`${collection}.init`);
          const statements = [
            { sql: `CREATE TABLE IF NOT EXISTS ${quote(collection)} (_id TEXT PRIMARY KEY NOT NULL, doc TEXT NOT NULL)` },
          ];
          for (const index of this._indexStatements(Model)) statements.push({ sql: index.sql });
          await this.client.batch(statements.map((s) => ({ sql: s.sql, args: [] })), 'write');
        })().catch((error) => {
          this._ensured.delete(collection);
          throw error;
        })
      );
    }
    return this._ensured.get(collection);
  }

  _indexStatements(Model) {
    const { schema, collectionName: collection } = Model;
    const seen = new Set();
    const out = [];

    for (const { fields, options } of schema.indexes) {
      const keys = Object.keys(fields);

      if (options && options.expireAfterSeconds !== undefined && keys.length === 1) {
        this._ttl.push({ collection, path: keys[0], seconds: options.expireAfterSeconds });
      }

      const eligible =
        keys.length > 0 &&
        keys.every((k) => {
          if (typeof fields[k] === 'string') return false; // 2dsphere, text, hashed
          const desc = schema.paths.get(k);
          return k === '_id' || (desc && SCALAR_KINDS.has(desc.kind));
        });
      if (!eligible) continue;

      const columns = keys.filter((k) => k !== '_id');
      if (columns.length === 0) continue;

      const unique = !!(options && options.unique);
      const name = `${unique ? 'uq' : 'ix'}_${collection}__${columns.map((k) => `${k.replace(/\./g, '_')}_${fields[k] === -1 ? 'n1' : '1'}`).join('__')}`;
      if (seen.has(name)) continue;
      seen.add(name);

      const parts = columns.map((k) => `${jsonExtract(k)} ${fields[k] === -1 ? 'DESC' : 'ASC'}`);
      out.push({ name, sql: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(name)} ON ${quote(collection)} (${parts.join(', ')})` });
      if (unique) this._uniqueIndexes.set(name, { collection, fields: columns });
    }
    return out;
  }

  /** Deletes documents whose TTL field has passed (replaces MongoDB's TTL monitor). */
  async sweepExpired() {
    for (const rule of this._ttl) {
      try {
        const cutoff = new Date(Date.now() - rule.seconds * 1000).toISOString();
        await this.client.execute({
          sql: `DELETE FROM ${quote(rule.collection)} WHERE ${jsonExtract(rule.path)} <= ?`,
          args: [cutoff],
        });
      } catch (error) {
        if (!/no such table/i.test(error.message || '')) {
          console.error(`[db] TTL sweep failed for ${rule.collection}:`, error.message);
        }
      }
    }
  }

  _startSweeper() {
    if (this._sweeper) clearInterval(this._sweeper);
    this._sweeper = setInterval(() => {
      if (this.readyState === 1) this.sweepExpired();
    }, 60 * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  /** Turns SQLite constraint errors into MongoDB-style duplicate key errors. */
  mapError(error, collection, valueSource) {
    const message = (error && error.message) || '';
    if (!/UNIQUE constraint failed/i.test(message)) return error;

    const indexMatch = message.match(/index '([^']+)'/);
    let fields = ['_id'];
    let indexName = '_id_';
    if (indexMatch && this._uniqueIndexes.has(indexMatch[1])) {
      fields = this._uniqueIndexes.get(indexMatch[1]).fields;
      indexName = fields.map((f) => `${f}_1`).join('_');
    }
    const keyPattern = {};
    const keyValue = {};
    for (const f of fields) {
      keyPattern[f] = 1;
      keyValue[f] = valueSource ? getPath(valueSource, f) : undefined;
    }
    return new DuplicateKeyError(`${this.name}.${collection}`, indexName, keyPattern, keyValue);
  }
}

module.exports = { Database, STATES, quote };
