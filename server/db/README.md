# Database layer (Turso / libSQL)

The server stores its data in [Turso](https://turso.tech) (hosted SQLite, "libSQL"). This folder is a
small, Mongoose-compatible layer on top of it, so the models, controllers, routes and sockets keep
using the same `Model.find()`, `doc.save()`, `populate()`, hooks and aggregation calls as before.

```js
const mongoose = require('../db');          // same shape as the mongoose module
const UserSchema = new mongoose.Schema({ ... });
module.exports = mongoose.model('User', UserSchema);
```

## Configuration

| Variable | Meaning |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://<db>-<org>.turso.io` for Turso, or `file:./data/gantavyam.db` for a local SQLite file |
| `TURSO_AUTH_TOKEN` | Turso database token (not needed for `file:` URLs) |
| `TURSO_TRANSPORT` | optional; `websocket` to use a WebSocket instead of HTTPS (HTTPS is the default and the most robust on Cloud Run) |

Tables and indexes are created automatically the first time a model is used.

## How data is stored

One table per collection (same names Mongoose used: `users`, `drivers`, `riderequests`, ...):

```sql
CREATE TABLE users (_id TEXT PRIMARY KEY, doc TEXT NOT NULL);   -- doc holds the document as JSON
```

* `_id` is a 24-character hex id, generated like MongoDB's ObjectId, so ids in API responses look the same.
* Dates are stored as ISO-8601 strings and turned back into `Date` objects when documents are loaded.
* Every `index: true` / `unique: true` / `schema.index(...)` becomes a SQLite expression index on
  `json_extract(doc, '$.field')`, and the query planner uses them for filters and sorts.
* Updates (`save()`, `findByIdAndUpdate`, ...) change only the touched JSON paths, and `$inc` is atomic, so two
  writers changing different fields do not overwrite each other. Upserts are atomic too.
* TTL indexes (`expireAfterSeconds`) are honoured by a sweeper that runs every minute.

## What is supported

* Schemas: types, nested objects, arrays of scalars / sub-documents / refs, `default`, `required`, `enum`, `min`/`max`,
  `minlength`/`maxlength`, `match`, `validate`, `trim`/`lowercase`/`uppercase`, `select: false`, `unique`/`sparse`,
  `timestamps`, virtuals, instance methods, statics, `pre`/`post` hooks (`save`, `insertMany`).
* Documents: `new Model()`, `save()`, `validate()`, `isModified()`, `toObject()`/`toJSON()`, `populate()`.
* Queries: `find`, `findOne`, `findById`, `countDocuments`, `distinct`, `exists`, with `sort`, `select`, `limit`,
  `skip`, `lean`, `populate`; filters with `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex $or $and $near`.
* Writes: `create`, `insertMany`, `updateOne`, `updateMany`, `findOneAndUpdate` (+ `upsert`), `findByIdAndUpdate`,
  `deleteOne`, `deleteMany`, `findByIdAndDelete`, with `$set $unset $inc $setOnInsert`.
* Aggregation: all the usual stages and operators (run in memory after an SQL pre-filter on the leading `$match`).
  `$week` follows MongoDB's definition.
* Errors keep their MongoDB shape: `ValidationError` (`err.errors[path].message`), `CastError`, and duplicate keys
  with `err.code === 11000`, `err.keyPattern`, `err.keyValue`.

## Not supported

Transactions/sessions, change streams, `$push/$pull/$addToSet` and update pipelines, text search, and `2dsphere`
indexes (`$near` is computed in memory, which is fine for the small collections it is used on).

## Tests

```bash
npm test        # runs db/__tests__/*.test.js against throw-away SQLite files
```

## Moving existing MongoDB data

```bash
mongoexport --uri "<connection string>" --collection users --out export/users.json   # repeat per collection
node scripts/importMongoExport.js export --dry-run                                  # check first
node scripts/importMongoExport.js export                                             # import
```
