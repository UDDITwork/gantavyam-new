'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');

const { ObjectId } = mongoose.Schema.Types;
let file;

/* Mirrors the shape of the real User model: select:false password, hashing hook, nested objects,
   arrays of refs and of sub-documents with a field literally named "type". */
const UserSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Please add a name'] },
  email: {
    type: String,
    unique: true,
    sparse: true,
    match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email'],
  },
  phone: { type: String, required: [true, 'Please add a phone number'], unique: true },
  password: { type: String, required: [true, 'Please add a password'], minlength: 6, select: false },
  role: { type: String, default: 'user' },
  profileImage: { type: String, default: '' },
  rideHistory: [{ type: ObjectId, ref: 'RideHistoryT' }],
  rideStatistics: {
    totalRides: { type: Number, default: 0 },
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    longestRide: { distance: Number, date: Date },
    preferredMetroStations: [{ stationName: String, usageCount: Number }],
  },
  favorites: [
    {
      name: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], default: [0, 0] },
      },
    },
  ],
  paymentMethods: [
    {
      type: { type: String, enum: ['card', 'upi', 'cash'], default: 'cash' },
      details: { type: mongoose.Schema.Types.Mixed },
      isDefault: { type: Boolean, default: false },
    },
  ],
  lastLogin: { type: Date, default: Date.now },
});

UserSchema.pre('save', async function hash(next) {
  if (!this.isModified('password')) {
    next();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  this.password = `hashed:${this.password}`;
  next();
});
UserSchema.methods.matchPassword = async function matchPassword(entered) {
  return this.password === `hashed:${entered}`;
};
UserSchema.virtual('initials').get(function initials() {
  return (this.name || '').slice(0, 1).toUpperCase();
});

const User = mongoose.model('User', UserSchema);

const TimedSchema = new mongoose.Schema(
  {
    label: String,
    count: { type: Number, default: 0 },
    status: { type: String, enum: ['new', 'done'], default: 'new' },
    when: { type: Date, default: Date.now },
    lastSeen: { type: String, default: () => 'now' },
  },
  { timestamps: true, collection: 'timed_things' }
);
const Timed = mongoose.model('Timed', TimedSchema);

before(async () => {
  file = await connectTemp('documents');
});
after(async () => {
  await cleanup(file);
});

describe('defaults, casting and ids', () => {
  it('applies defaults, generates a 24-char hex _id and keeps empty arrays', async () => {
    const user = await User.create({ name: 'Asha', phone: '9000000001', password: 'secret1' });
    assert.match(String(user._id), /^[0-9a-f]{24}$/);
    assert.equal(user.role, 'user');
    assert.equal(user.profileImage, '');
    assert.deepEqual(user.rideHistory, []);
    assert.equal(user.rideStatistics.totalRides, 0);
    assert.ok(user.lastLogin instanceof Date);
    assert.equal(user.isNew, false);
    assert.equal(user.id, String(user._id));
  });

  it('adds createdAt/updatedAt for timestamps schemas and bumps updatedAt on change', async () => {
    const doc = await Timed.create({ label: 'a' });
    assert.ok(doc.createdAt instanceof Date);
    assert.equal(doc.createdAt.getTime(), doc.updatedAt.getTime());
    assert.equal(doc.lastSeen, 'now');
    await new Promise((r) => setTimeout(r, 15));
    doc.count = 4;
    await doc.save();
    const again = await Timed.findById(doc._id);
    assert.equal(again.count, 4);
    assert.ok(again.updatedAt.getTime() > again.createdAt.getTime());
    assert.equal(again.createdAt.getTime(), doc.createdAt.getTime());
  });

  it('casts strings to numbers and dates, and reports cast failures like Mongoose', async () => {
    const doc = await Timed.create({ label: 'cast', count: '5', when: '2026-01-02T03:04:05.000Z' });
    assert.strictEqual(doc.count, 5);
    assert.ok(doc.when instanceof Date);
    assert.equal(doc.when.toISOString(), '2026-01-02T03:04:05.000Z');

    await assert.rejects(Timed.create({ label: 'bad', count: 'abc' }), (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.match(err.message, /Cast to Number failed for value "abc" \(type string\) at path "count"/);
      return true;
    });
  });

  it('ignores paths that are not in the schema (strict mode)', async () => {
    const doc = await Timed.create({ label: 'strict', notInSchema: 'x' });
    const raw = await Timed.findById(doc._id).lean();
    assert.equal(raw.notInSchema, undefined);
  });
});

describe('validation', () => {
  it('uses custom required messages and the Mongoose message format', async () => {
    await assert.rejects(User.create({ phone: '9000000002' }), (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.errors.name.message, 'Please add a name');
      assert.equal(err.errors.password.message, 'Please add a password');
      assert.match(err.message, /^User validation failed: /);
      assert.match(err.message, /name: Please add a name/);
      return true;
    });
  });

  it('validates enum, min/max, minlength and match', async () => {
    await assert.rejects(Timed.create({ status: 'weird' }), /`weird` is not a valid enum value for path `status`\./);
    await assert.rejects(
      User.create({ name: 'x', phone: '9000000003', password: 'abc' }),
      /Path `password` \(`abc`\) is shorter than the minimum allowed length \(6\)\./
    );
    await assert.rejects(
      User.create({ name: 'x', phone: '9000000004', password: 'secret1', email: 'not-an-email' }),
      /Please add a valid email/
    );
    await assert.rejects(
      User.create({ name: 'x', phone: '9000000005', password: 'secret1', rideStatistics: { averageRating: 9 } }),
      /Path `rideStatistics.averageRating` \(9\) is more than maximum allowed value \(5\)\./
    );
  });

  it('validates enums inside arrays of sub-documents', async () => {
    await assert.rejects(
      User.create({ name: 'x', phone: '9000000006', password: 'secret1', paymentMethods: [{ type: 'bitcoin' }] }),
      /paymentMethods\.0\.type/
    );
  });
});

describe('select: false fields and hooks', () => {
  it('hides password by default, returns it with +password, and hashes on creation', async () => {
    const created = await User.create({ name: 'Ravi', phone: '9000000010', password: 'secret1' });
    const plain = await User.findById(created._id);
    assert.equal(plain.password, undefined);
    const withPassword = await User.findById(created._id).select('+password');
    assert.equal(withPassword.password, 'hashed:secret1');
    assert.equal(await withPassword.matchPassword('secret1'), true);
  });

  it('can save a user loaded without the password and does not touch it', async () => {
    const created = await User.create({ name: 'Sita', phone: '9000000011', password: 'secret1' });
    const loaded = await User.findById(created._id); // password not selected
    loaded.name = 'Sita Devi';
    loaded.lastLogin = new Date('2026-05-05T00:00:00.000Z');
    await loaded.save();
    await new Promise((r) => setTimeout(r, 30)); // let the hook's trailing code run
    const reread = await User.findById(created._id).select('+password');
    assert.equal(reread.name, 'Sita Devi');
    assert.equal(reread.password, 'hashed:secret1');
    assert.equal(reread.lastLogin.toISOString(), '2026-05-05T00:00:00.000Z');
  });

  it('re-hashes only when the password is modified', async () => {
    const created = await User.create({ name: 'Mohan', phone: '9000000012', password: 'secret1' });
    const loaded = await User.findById(created._id).select('+password');
    loaded.password = 'newsecret';
    await loaded.save();
    const reread = await User.findById(created._id).select('+password');
    assert.equal(reread.password, 'hashed:newsecret');
  });
});

describe('methods, virtuals and output', () => {
  it('exposes instance methods and virtuals, and keeps virtuals out of JSON', async () => {
    const created = await User.create({ name: 'neha', phone: '9000000020', password: 'secret1' });
    assert.equal(created.initials, 'N');
    const json = JSON.parse(JSON.stringify(created));
    assert.equal(json.initials, undefined);
    assert.equal(created.toObject({ virtuals: true }).initials, 'N');
  });

  it('serialises ids as strings and dates as ISO strings, and drops empty nested objects', async () => {
    const created = await User.create({ name: 'json', phone: '9000000021', password: 'secret1' });
    const json = JSON.parse(JSON.stringify(await User.findById(created._id)));
    assert.equal(typeof json._id, 'string');
    assert.match(json.lastLogin, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(json.password, undefined);
    assert.equal(json.rideStatistics.longestRide, undefined); // empty nested object is minimised away
  });

  it('lets Object.assign(doc, data) go through the setters', async () => {
    const doc = await Timed.create({ label: 'assign' });
    Object.assign(doc, { count: 7, status: 'done', notAField: 1 });
    await doc.save();
    const again = await Timed.findById(doc._id).lean();
    assert.equal(again.count, 7);
    assert.equal(again.status, 'done');
    assert.equal(again.notAField, undefined);
  });
});

describe('change tracking and partial saves', () => {
  it('writes only the changed paths, so concurrent writers to different fields both win', async () => {
    const created = await User.create({ name: 'Race', phone: '9000000030', password: 'secret1' });
    const a = await User.findById(created._id);
    const b = await User.findById(created._id);
    a.name = 'From A';
    b.rideStatistics.totalRides = 12;
    await Promise.all([a.save(), b.save()]);
    const reread = await User.findById(created._id).lean();
    assert.equal(reread.name, 'From A');
    assert.equal(reread.rideStatistics.totalRides, 12);
  });

  it('reports isModified for direct sets and nested changes', async () => {
    const created = await User.create({ name: 'Mod', phone: '9000000031', password: 'secret1' });
    const loaded = await User.findById(created._id);
    assert.equal(loaded.isModified(), false);
    loaded.rideStatistics.totalRides += 1;
    assert.equal(loaded.isModified('rideStatistics'), true);
    assert.equal(loaded.isModified('rideStatistics.totalRides'), true);
    assert.equal(loaded.isModified('name'), false);
    await loaded.save();
    assert.equal(loaded.isModified(), false);
  });

  it('does not hit the database when nothing changed', async () => {
    const created = await User.create({ name: 'Idle', phone: '9000000032', password: 'secret1' });
    const loaded = await User.findById(created._id);
    const before = (await User.findById(created._id).lean()).updatedAt;
    await loaded.save();
    assert.equal((await User.findById(created._id).lean()).updatedAt, before);
  });
});

describe('sub-document arrays', () => {
  it('gives pushed items defaults and ids, and persists in-place edits', async () => {
    const created = await User.create({
      name: 'Subdocs',
      phone: '9000000040',
      password: 'secret1',
      paymentMethods: [{ details: { upi: 'a@b' } }],
    });
    assert.equal(created.paymentMethods[0].type, 'cash');
    assert.equal(created.paymentMethods[0].isDefault, false);
    assert.match(String(created.paymentMethods[0]._id), /^[0-9a-f]{24}$/);

    const loaded = await User.findById(created._id);
    loaded.paymentMethods.push({ type: 'upi', isDefault: true });
    loaded.paymentMethods[0].isDefault = true;
    loaded.favorites.push({ name: 'Home' });
    await loaded.save();

    const reread = await User.findById(created._id).lean();
    assert.equal(reread.paymentMethods.length, 2);
    assert.equal(reread.paymentMethods[0].isDefault, true);
    assert.equal(reread.paymentMethods[1].type, 'upi');
    assert.match(String(reread.paymentMethods[1]._id), /^[0-9a-f]{24}$/);
    assert.deepEqual(reread.favorites[0].location.coordinates, [0, 0]);
    assert.equal(reread.favorites[0].location.type, 'Point');
  });

  it('supports reassigning an array property', async () => {
    const created = await User.create({
      name: 'Reassign',
      phone: '9000000041',
      password: 'secret1',
      favorites: [{ name: 'A' }, { name: 'B' }],
    });
    const loaded = await User.findById(created._id);
    loaded.favorites = loaded.favorites.filter((f) => f.name !== 'A');
    await loaded.save();
    const reread = await User.findById(created._id).lean();
    assert.deepEqual(reread.favorites.map((f) => f.name), ['B']);
  });
});

describe('unique indexes', () => {
  it('rejects duplicates with a MongoDB-style duplicate key error', async () => {
    await User.create({ name: 'First', phone: '9000000050', password: 'secret1' });
    await assert.rejects(User.create({ name: 'Second', phone: '9000000050', password: 'secret1' }), (err) => {
      assert.equal(err.code, 11000);
      assert.deepEqual(err.keyPattern, { phone: 1 });
      assert.deepEqual(err.keyValue, { phone: '9000000050' });
      return true;
    });
  });

  it('allows many documents without an optional sparse unique field, but not repeated values', async () => {
    await User.create({ name: 'NoMail1', phone: '9000000051', password: 'secret1' });
    await User.create({ name: 'NoMail2', phone: '9000000052', password: 'secret1' });
    await User.create({ name: 'Mail1', phone: '9000000053', password: 'secret1', email: 'dup@example.com' });
    await assert.rejects(
      User.create({ name: 'Mail2', phone: '9000000054', password: 'secret1', email: 'dup@example.com' }),
      (err) => err.code === 11000 && err.keyPattern.email === 1
    );
  });

  it('reports duplicate keys on update paths too', async () => {
    const a = await User.create({ name: 'U1', phone: '9000000055', password: 'secret1' });
    await User.create({ name: 'U2', phone: '9000000056', password: 'secret1' });
    await assert.rejects(User.findByIdAndUpdate(a._id, { $set: { phone: '9000000056' } }), (err) => err.code === 11000);
    const loaded = await User.findById(a._id);
    loaded.phone = '9000000056';
    await assert.rejects(loaded.save(), (err) => err.code === 11000);
  });
});

describe('ObjectId helpers', () => {
  it('works with new mongoose.Types.ObjectId(...) in either call style', () => {
    const hex = new mongoose.Types.ObjectId().toString();
    assert.match(hex, /^[0-9a-f]{24}$/);
    assert.equal(new mongoose.Types.ObjectId(hex).toString(), hex);
    assert.equal(mongoose.Types.ObjectId(hex).toString(), hex);
    assert.equal(mongoose.Types.ObjectId.isValid(hex), true);
    assert.equal(mongoose.Types.ObjectId.isValid('nope'), false);
    assert.equal(mongoose.isValidObjectId(hex), true);
    assert.equal(new mongoose.Types.ObjectId(hex).equals(hex), true);
  });
});
