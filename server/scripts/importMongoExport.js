#!/usr/bin/env node
/**
 * Imports data exported from MongoDB into the Turso / libSQL database.
 *
 *   node scripts/importMongoExport.js <export-dir> [--replace] [--dry-run]
 *
 * The directory holds one file per collection, named after the collection (users.json,
 * drivers.json, riderequests.json, ...). Each file is either a JSON array or one JSON document
 * per line, in MongoDB Extended JSON (what `mongoexport` writes), e.g.
 *
 *   mongoexport --uri "<connection string>" --collection users --out users.json
 *
 * The target database comes from TURSO_DATABASE_URL / TURSO_AUTH_TOKEN (server/.env or the
 * environment). Existing rows with the same _id are skipped, or overwritten with --replace.
 * --dry-run converts and validates everything without writing.
 */

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, '..', 'models');

/** Converts MongoDB Extended JSON values ($oid, $date, $numberLong, ...) to plain JSON values. */
function fromExtendedJson(value) {
  if (Array.isArray(value)) return value.map(fromExtendedJson);
  if (value === null || typeof value !== 'object') return value;

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0];
    const inner = value[key];
    switch (key) {
      case '$oid':
        return String(inner).toLowerCase();
      case '$date': {
        const raw = inner !== null && typeof inner === 'object' ? inner.$numberLong : inner;
        const date = new Date(typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw);
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
      }
      case '$numberLong':
      case '$numberInt':
      case '$numberDouble':
      case '$numberDecimal':
        return Number(inner);
      default:
        break;
    }
  }

  const out = {};
  for (const key of keys) out[key] = fromExtendedJson(value[key]);
  return out;
}

function readDocuments(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function loadModels() {
  for (const name of fs.readdirSync(MODELS_DIR)) {
    if (name.endsWith('.js')) require(path.join(MODELS_DIR, name));
  }
  return require('../db');
}

/** Imports every known collection found in `dir`. The database must already be connected. */
async function importExport(dir, { replace = false, dryRun = false, log = console.log } = {}) {
  const mongoose = loadModels();
  const summary = {};

  for (const Model of Object.values(mongoose.models)) {
    const candidates = [`${Model.collectionName}.json`, `${Model.collectionName}.jsonl`, `${Model.collectionName}.ndjson`];
    const file = candidates.map((c) => path.join(dir, c)).find((f) => fs.existsSync(f));
    if (!file) continue;

    const docs = readDocuments(file).map(fromExtendedJson);
    const result = { read: docs.length, inserted: 0, skipped: 0, failed: 0 };
    summary[Model.collectionName] = result;
    if (dryRun) {
      log(`[dry-run] ${Model.collectionName}: ${docs.length} documents ready`);
      continue;
    }

    await Model.db.ensureModel(Model);
    const verb = replace ? 'INSERT OR REPLACE' : 'INSERT';
    const sql = `${verb} INTO "${Model.collectionName}" (_id, doc) VALUES (?, ?)`;
    const toRow = (doc) => {
      const { _id, __v, ...rest } = doc;
      if (!_id) throw new Error('document without _id');
      return { sql, args: [String(_id), JSON.stringify(rest)] };
    };

    for (let i = 0; i < docs.length; i += 100) {
      const chunk = docs.slice(i, i + 100);
      try {
        await Model.db.batch(chunk.map(toRow));
        result.inserted += chunk.length;
      } catch (batchError) {
        // fall back to one by one so a single duplicate does not hide the rest
        for (const doc of chunk) {
          try {
            await Model.db.batch([toRow(doc)]);
            result.inserted += 1;
          } catch (error) {
            if (/UNIQUE constraint failed/i.test(error.message || '')) {
              result.skipped += 1;
            } else {
              result.failed += 1;
              log(`  ! ${Model.collectionName} ${doc._id || ''}: ${error.message}`);
            }
          }
        }
      }
    }
    log(`${Model.collectionName}: ${result.inserted} inserted, ${result.skipped} already present, ${result.failed} failed (of ${result.read})`);
  }
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Usage: node scripts/importMongoExport.js <export-dir> [--replace] [--dry-run]');
    process.exit(1);
  }
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

  const mongoose = loadModels();
  await mongoose.connect({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  console.log(`Importing ${path.resolve(dir)} into ${mongoose.connection.host}...`);
  try {
    await importExport(path.resolve(dir), { replace: args.includes('--replace'), dryRun: args.includes('--dry-run') });
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Import failed:', error.message);
    process.exit(1);
  });
}

module.exports = { importExport, fromExtendedJson };
