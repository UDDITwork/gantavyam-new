'use strict';

/**
 * Minimal ObjectId: 24-character hex identifiers, generated the same way MongoDB does
 * (4-byte timestamp + 5-byte process-unique value + 3-byte counter).
 *
 * Inside the database layer ids are always plain lowercase hex strings. This class exists so
 * that existing code such as `new mongoose.Types.ObjectId(id)` keeps working; instances are
 * converted back to strings before they are stored or compared.
 */
const crypto = require('crypto');

const HEX24 = /^[0-9a-fA-F]{24}$/;
const processUnique = crypto.randomBytes(5);
let counter = crypto.randomBytes(3).readUIntBE(0, 3);

function generateHex() {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  processUnique.copy(buf, 4);
  counter = (counter + 1) % 0x1000000;
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString('hex');
}

function ObjectId(id) {
  if (!(this instanceof ObjectId)) return new ObjectId(id);

  if (id === undefined || id === null) {
    this._hex = generateHex();
    return;
  }
  if (id instanceof ObjectId) {
    this._hex = id._hex;
    return;
  }

  let str;
  if (typeof id === 'string') str = id;
  else if (typeof id.toHexString === 'function') str = id.toHexString();
  else if (id._id !== undefined) str = String(id._id);
  else str = String(id);

  if (!HEX24.test(str)) {
    throw new TypeError('input must be a 24 character hex string');
  }
  this._hex = str.toLowerCase();
}

ObjectId.prototype.toString = function toString() {
  return this._hex;
};
ObjectId.prototype.toHexString = ObjectId.prototype.toString;
ObjectId.prototype.toJSON = ObjectId.prototype.toString;
ObjectId.prototype.valueOf = ObjectId.prototype.toString;
ObjectId.prototype.equals = function equals(other) {
  if (other === null || other === undefined) return false;
  return String(other).toLowerCase() === this._hex;
};
ObjectId.prototype.getTimestamp = function getTimestamp() {
  return new Date(parseInt(this._hex.slice(0, 8), 16) * 1000);
};
ObjectId.prototype[Symbol.for('nodejs.util.inspect.custom')] = function inspect() {
  return `new ObjectId("${this._hex}")`;
};

ObjectId.isValid = function isValid(id) {
  if (id === null || id === undefined) return false;
  if (id instanceof ObjectId) return true;
  if (typeof id === 'string') return HEX24.test(id);
  if (typeof id.toHexString === 'function') return HEX24.test(id.toHexString());
  return false;
};

/** Returns the lowercase hex string for an ObjectId / valid hex string, otherwise null. */
function toHex(value) {
  if (value instanceof ObjectId) return value._hex;
  if (typeof value === 'string' && HEX24.test(value)) return value.toLowerCase();
  if (value && typeof value.toHexString === 'function') {
    const hex = value.toHexString();
    if (HEX24.test(hex)) return hex.toLowerCase();
  }
  return null;
}

module.exports = { ObjectId, toHex, generateHex, HEX24 };
