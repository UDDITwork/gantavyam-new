'use strict';

/**
 * Drop-in replacement for the parts of Mongoose this project uses, storing documents in
 * Turso / libSQL instead of MongoDB.
 *
 *   const mongoose = require('../db');
 *   const UserSchema = new mongoose.Schema({ ... });
 *   module.exports = mongoose.model('User', UserSchema);
 *   await mongoose.connect({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
 */

const { Database, STATES } = require('./client');
const { Schema } = require('./schema');
const { ObjectId } = require('./objectid');
const errors = require('./errors');
const { createModel, pluralize, Document } = require('./model');

const db = new Database();

const api = {
  Schema,
  Document,
  Types: { ObjectId },
  ObjectId,
  STATES,
  connection: db,
  Error: errors.MongooseError,
  CastError: errors.CastError,
  ValidationError: errors.ValidationError,
  DocumentNotFoundError: errors.DocumentNotFoundError,

  get models() {
    return Object.fromEntries(db.models);
  },

  model(name, schema, collection) {
    if (!schema) {
      const existing = db.models.get(name);
      if (!existing) throw new errors.MissingSchemaError(name);
      return existing;
    }
    if (db.models.has(name)) {
      throw new errors.MongooseError(`Cannot overwrite \`${name}\` model once compiled.`);
    }
    const collectionName = collection || schema.options.collection || pluralize(name);
    const Model = createModel(db, name, schema, collectionName);
    db.models.set(name, Model);
    return Model;
  },

  async connect(...args) {
    await db.connect(...args);
    return api;
  },

  disconnect() {
    return db.disconnect();
  },

  isValidObjectId(value) {
    return ObjectId.isValid(value);
  },

  set() {
    return api;
  },

  plugin() {
    return api;
  },
};

module.exports = api;
module.exports.default = api;
