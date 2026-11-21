'use strict';

/**
 * Error types that mirror the ones the controllers already look for:
 *   - err.name === 'ValidationError' with err.errors[path].message
 *   - err.name === 'CastError'
 *   - err.code === 11000 with err.keyPattern / err.keyValue (duplicate key)
 */

class MongooseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MongooseError';
  }
}

class ValidatorError extends MongooseError {
  constructor(properties) {
    super(properties.message);
    this.name = 'ValidatorError';
    this.properties = properties;
    this.kind = properties.type;
    this.path = properties.path;
    this.value = properties.value;
  }
}

class CastError extends MongooseError {
  constructor(kind, value, path, modelName) {
    let shown;
    try {
      shown = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
    } catch (e) {
      shown = String(value);
    }
    let message = `Cast to ${kind} failed for value ${shown} (type ${valueType(value)}) at path "${path}"`;
    if (modelName) message += ` for model "${modelName}"`;
    super(message);
    this.name = 'CastError';
    this.kind = kind;
    this.value = value;
    this.path = path;
    this.stringValue = shown;
  }
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'Array';
  if (value instanceof Date) return 'Date';
  return typeof value;
}

class ValidationError extends MongooseError {
  constructor(modelName) {
    super(modelName ? `${modelName} validation failed` : 'Validation failed');
    this.name = 'ValidationError';
    this.errors = {};
    this._message = this.message;
  }

  addError(path, error) {
    this.errors[path] = error;
    const detail = Object.keys(this.errors)
      .map((p) => `${p}: ${this.errors[p].message}`)
      .join(', ');
    this.message = `${this._message}: ${detail}`;
  }
}

class DocumentNotFoundError extends MongooseError {
  constructor(filter, modelName) {
    super(`No document found for query ${JSON.stringify(filter)} on model "${modelName}"`);
    this.name = 'DocumentNotFoundError';
    this.filter = filter;
  }
}

class MissingSchemaError extends MongooseError {
  constructor(name) {
    super(`Schema hasn't been registered for model "${name}".\nUse mongoose.model(name, schema)`);
    this.name = 'MissingSchemaError';
  }
}

/** Shaped like the MongoDB driver's duplicate-key error (code 11000). */
class DuplicateKeyError extends Error {
  constructor(collection, indexName, keyPattern, keyValue) {
    const shownValue = Object.keys(keyValue)
      .map((k) => `${k}: ${JSON.stringify(keyValue[k])}`)
      .join(', ');
    super(`E11000 duplicate key error collection: ${collection} index: ${indexName} dup key: { ${shownValue} }`);
    this.name = 'MongoServerError';
    this.code = 11000;
    this.keyPattern = keyPattern;
    this.keyValue = keyValue;
  }
}

module.exports = {
  MongooseError,
  ValidatorError,
  CastError,
  ValidationError,
  DocumentNotFoundError,
  MissingSchemaError,
  DuplicateKeyError,
};
