'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');

const { ObjectId } = mongoose.Schema.Types;
let file;

const Thing = mongoose.model(
  'Thing',
  new mongoose.Schema(
    {
      name: String,
      count: { type: Number, default: 0 },
      status: { type: String, default: 'new' },
      stats: { rides: { type: Number, default: 0 }, deep: { a: { b: Number } } },
      note: String,
    },
    { timestamps: true }
  )
);

const CounterSchema = new mongoose.Schema(
  {
    boothName: { type: String, required: true },
    date: { type: String, required: true },
    dailyCounter: { type: Number, default: 0, min: 0 },
    totalToday: { type: Number, default: 0 },
    activeRides: [
      {
        rideId: { type: ObjectId },
        queueNumber: String,
        status: { type: String, enum: ['queued', 'in_progress', 'completed'], default: 'queued' },
        assignedAt: { type: Date, default: Date.now },
      },
    ],
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
CounterSchema.index({ boothName: 1, date: 1 }, { unique: true });
CounterSchema.pre('save', function touch(next) {
  this.lastUpdated = new Date();
  next();
});
CounterSchema.methods.addToQueue = function addToQueue(rideId) {
  this.dailyCounter += 1;
  this.totalToday += 1;
  this.activeRides.push({ rideId, queueNumber: `Q${this.dailyCounter}`, status: 'queued' });
  return this.dailyCounter;
};
CounterSchema.methods.updateRideStatus = function updateRideStatus(rideId, status) {
  const ride = this.activeRides.find((r) => r.rideId.toString() === rideId.toString());
  if (!ride) return false;
  ride.status = status;
  return true;
};
CounterSchema.methods.removeFromQueue = function removeFromQueue(rideId) {
  const before = this.activeRides.length;
  this.activeRides = this.activeRides.filter((r) => r.rideId.toString() !== rideId.toString());
  return this.activeRides.length < before;
};
const Counter = mongoose.model('Counter', CounterSchema);

const ReqSchema = new mongoose.Schema(
  {
    driverId: { type: ObjectId, required: true },
    driverName: String,
    status: { type: String, default: 'pending' },
    expiresAt: { type: Date },
    boothName: String,
    location: { type: { type: String, default: 'Point' }, coordinates: { type: [Number], default: [0, 0] } },
    requestedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
ReqSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ReqSchema.index({ status: 1, requestedAt: -1 });
ReqSchema.pre('save', function expiry(next) {
  if (this.isNew && !this.expiresAt) this.expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  next();
});
const Req = mongoose.model('Req', ReqSchema);

const transitions = { pending: ['driver_assigned', 'cancelled'], driver_assigned: ['ride_started', 'cancelled'], ride_started: ['completed'], completed: [], cancelled: [] };
const FlowSchema = new mongoose.Schema(
  {
    status: { type: String, default: 'pending' },
    driverId: { type: ObjectId },
    startedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true }
);
FlowSchema.pre('save', async function flow(next) {
  if (this.isModified('status') && !this.isNew) {
    try {
      const old = await this.constructor.findById(this._id);
      if (old && old.status !== this.status && !(transitions[old.status] || []).includes(this.status)) {
        return next(new Error(`Invalid status transition from ${old.status} to ${this.status}`));
      }
    } catch (error) {
      return next(error);
    }
  }
  if (this.status === 'ride_started' && !this.startedAt) this.startedAt = new Date();
  if (this.status === 'cancelled' && !this.cancelledAt) this.cancelledAt = new Date();
  next();
});
FlowSchema.methods.updateStatus = function updateStatus(status, extra = {}) {
  if (!(transitions[this.status] || []).includes(status)) throw new Error(`Invalid status transition from ${this.status} to ${status}`);
  this.status = status;
  Object.assign(this, extra);
  return this.save();
};
const Flow = mongoose.model('Flow', FlowSchema);

const Place = mongoose.model(
  'Place',
  (() => {
    const s = new mongoose.Schema({ name: String, lat: Number, lng: Number, coordinates: { type: { type: String, default: 'Point' }, coordinates: [Number] } });
    s.pre('insertMany', function fill(next, docs) {
      if (Array.isArray(docs)) {
        docs.forEach((d) => {
          if (d.lat && d.lng) d.coordinates = { type: 'Point', coordinates: [d.lng, d.lat] };
        });
      }
      next();
    });
    return s;
  })()
);

before(async () => {
  file = await connectTemp('updates');
});
after(async () => {
  await cleanup(file);
});

describe('findByIdAndUpdate / updateOne', () => {
  it('applies $set, $inc and $unset, creating nested parents and missing counters', async () => {
    const t = await Thing.create({ name: 'a', note: 'remove me' });
    const updated = await Thing.findByIdAndUpdate(
      t._id,
      { $set: { status: 'done', 'stats.deep.a.b': 7 }, $inc: { count: 3, 'stats.rides': 2 }, $unset: { note: 1 } },
      { new: true }
    );
    assert.equal(updated.status, 'done');
    assert.equal(updated.count, 3);
    assert.equal(updated.stats.rides, 2);
    assert.equal(updated.stats.deep.a.b, 7);
    assert.equal(updated.note, undefined);
    const again = await Thing.findByIdAndUpdate(t._id, { $inc: { count: 1 } }, { new: true });
    assert.equal(again.count, 4);
  });

  it('returns the previous document unless new:true, and null when nothing matches', async () => {
    const t = await Thing.create({ name: 'old', count: 1 });
    const before = await Thing.findByIdAndUpdate(t._id, { $set: { count: 9 } });
    assert.equal(before.count, 1);
    assert.equal((await Thing.findById(t._id)).count, 9);
    assert.equal(await Thing.findByIdAndUpdate(String(new mongoose.Types.ObjectId()), { $set: { count: 1 } }), null);
  });

  it('treats plain fields as $set, strips unknown paths, and bumps updatedAt', async () => {
    const t = await Thing.create({ name: 'strict' });
    await new Promise((r) => setTimeout(r, 15));
    const updated = await Thing.findOneAndUpdate({ _id: t._id }, { status: 'x', unknownField: 5, $inc: { notAField: 1 } }, { new: true });
    assert.equal(updated.status, 'x');
    assert.equal((await Thing.findById(t._id).lean()).unknownField, undefined);
    assert.ok(updated.updatedAt.getTime() > t.createdAt.getTime());
  });

  it('casts update values and rejects impossible ones', async () => {
    const t = await Thing.create({ name: 'cast' });
    const updated = await Thing.findByIdAndUpdate(t._id, { $set: { count: '12' } }, { new: true });
    assert.strictEqual(updated.count, 12);
    await assert.rejects(Thing.findByIdAndUpdate(t._id, { $set: { count: 'nope' } }), (err) => err.name === 'CastError');
  });

  it('updateOne reports matched and modified counts', async () => {
    const t = await Thing.create({ name: 'u1' });
    const hit = await Thing.updateOne({ _id: t._id }, { $set: { status: 'seen' } });
    assert.equal(hit.matchedCount, 1);
    assert.equal(hit.modifiedCount, 1);
    const miss = await Thing.updateOne({ name: 'no such thing' }, { $set: { status: 'seen' } });
    assert.equal(miss.matchedCount, 0);
    assert.equal(miss.modifiedCount, 0);
  });
});

describe('updateMany', () => {
  it('updates every match for exact and in-memory filters', async () => {
    await Thing.deleteMany({});
    await Thing.insertMany([{ name: 'm1', note: 'alpha' }, { name: 'm2', note: 'alpha beta' }, { name: 'm3', note: 'gamma' }]);

    const exact = await Thing.updateMany({ name: { $in: ['m1', 'm2'] } }, { $set: { status: 'bulk' } });
    assert.equal(exact.matchedCount, 2);
    assert.equal(await Thing.countDocuments({ status: 'bulk' }), 2);

    const viaRegex = await Thing.updateMany({ note: { $regex: 'alpha' } }, { $inc: { count: 5 } });
    assert.equal(viaRegex.modifiedCount, 2);
    assert.deepEqual((await Thing.find({ count: 5 }).sort('name')).map((t) => t.name), ['m1', 'm2']);
  });

  it('is a no-op when nothing matches', async () => {
    const result = await Thing.updateMany({ name: 'nobody' }, { $set: { status: 'x' } });
    assert.equal(result.modifiedCount, 0);
  });
});

describe('upserts', () => {
  it('creates once from filter equality + $setOnInsert and returns the existing document afterwards', async () => {
    const driverId = new mongoose.Types.ObjectId();
    const first = await Req.findOneAndUpdate(
      { driverId, status: 'pending' },
      { $setOnInsert: { driverName: 'Dev', boothName: 'Rajiv Chowk', requestedAt: new Date(), location: undefined } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    assert.equal(first.driverName, 'Dev');
    assert.equal(String(first.driverId), String(driverId));
    assert.equal(first.status, 'pending');
    assert.deepEqual(first.location.coordinates, [0, 0]);
    assert.ok(first.createdAt instanceof Date);

    const second = await Req.findOneAndUpdate(
      { driverId, status: 'pending' },
      { $setOnInsert: { driverName: 'Someone Else' } },
      { upsert: true, new: true }
    );
    assert.equal(String(second._id), String(first._id));
    assert.equal(second.driverName, 'Dev');
    assert.equal(await Req.countDocuments({ driverId }), 1);
  });

  it('returns null for an inserted document when new is not requested', async () => {
    const driverId = new mongoose.Types.ObjectId();
    const result = await Req.findOneAndUpdate({ driverId, status: 'pending' }, { $setOnInsert: { driverName: 'x' } }, { upsert: true });
    assert.equal(result, null);
    assert.equal(await Req.countDocuments({ driverId }), 1);
  });

  it('creates exactly one document when many requests upsert at the same time', async () => {
    const driverId = new mongoose.Types.ObjectId();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        Req.findOneAndUpdate({ driverId, status: 'pending' }, { $setOnInsert: { driverName: 'Racer' } }, { upsert: true, new: true })
      )
    );
    assert.equal(await Req.countDocuments({ driverId }), 1);
    assert.equal(new Set(results.map((r) => String(r._id))).size, 1);
  });

  it('increments a counter atomically under concurrency (single document per booth/day)', async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        Counter.findOneAndUpdate(
          { boothName: 'Hauz Khas', date: '2026-01-01' },
          { $inc: { dailyCounter: 1, totalToday: 1 }, $setOnInsert: { boothCode: 'HAUZ' } },
          { upsert: true, new: true }
        )
      )
    );
    assert.equal(await Counter.countDocuments({ boothName: 'Hauz Khas', date: '2026-01-01' }), 1);
    const final = await Counter.findOne({ boothName: 'Hauz Khas', date: '2026-01-01' });
    assert.equal(final.dailyCounter, 15);
    assert.equal(final.totalToday, 15);
    assert.deepEqual(results.map((r) => r.dailyCounter).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i + 1));
  });
});

describe('queue-style documents', () => {
  it('adds, updates and removes queue entries through methods + save()', async () => {
    const queue = await Counter.create({ boothName: 'Kashmere Gate', date: '2026-02-02' });
    const rideA = new mongoose.Types.ObjectId();
    const rideB = new mongoose.Types.ObjectId();

    assert.equal(queue.addToQueue(rideA), 1);
    assert.equal(queue.addToQueue(rideB), 2);
    await queue.save();

    const loaded = await Counter.findById(queue._id);
    assert.equal(loaded.activeRides.length, 2);
    assert.equal(loaded.activeRides[0].queueNumber, 'Q1');
    assert.equal(loaded.activeRides[0].status, 'queued');
    assert.ok(loaded.activeRides[0].assignedAt instanceof Date);

    assert.equal(loaded.updateRideStatus(rideA, 'in_progress'), true);
    await loaded.save();
    assert.equal((await Counter.findById(queue._id).lean()).activeRides[0].status, 'in_progress');

    const again = await Counter.findById(queue._id);
    assert.equal(again.removeFromQueue(rideA), true);
    await again.save();
    const finalQueue = await Counter.findById(queue._id).lean();
    assert.equal(finalQueue.activeRides.length, 1);
    assert.equal(finalQueue.activeRides[0].queueNumber, 'Q2');
  });

  it('validates enum values on array items when saving', async () => {
    const queue = await Counter.create({ boothName: 'Airport', date: '2026-03-03' });
    queue.activeRides.push({ rideId: new mongoose.Types.ObjectId(), status: 'teleported' });
    await assert.rejects(queue.save(), /activeRides\.0\.status/);
  });

  it('enforces the unique booth/date index', async () => {
    await Counter.create({ boothName: 'Dup', date: '2026-04-04' });
    await assert.rejects(Counter.create({ boothName: 'Dup', date: '2026-04-04' }), (err) => err.code === 11000);
  });
});

describe('hooks and methods', () => {
  it('runs pre-save hooks after validation and lets them reject invalid status transitions', async () => {
    const flow = await Flow.create({});
    assert.equal(flow.status, 'pending');

    // like the real model, updateStatus() throws synchronously for an invalid transition
    assert.throws(() => flow.updateStatus('completed'), /Invalid status transition from pending to completed/);

    await flow.updateStatus('driver_assigned', { driverId: new mongoose.Types.ObjectId() });
    await flow.updateStatus('ride_started');
    const started = await Flow.findById(flow._id);
    assert.equal(started.status, 'ride_started');
    assert.ok(started.startedAt instanceof Date);

    // direct assignment goes through the same hook
    started.status = 'pending';
    await assert.rejects(started.save(), /Invalid status transition from ride_started to pending/);
  });

  it('stamps cancellation time from the hook', async () => {
    const flow = await Flow.create({});
    await flow.updateStatus('cancelled');
    assert.ok((await Flow.findById(flow._id)).cancelledAt instanceof Date);
  });

  it('supports validateBeforeSave: false', async () => {
    const r = await Req.create({ driverId: new mongoose.Types.ObjectId() });
    r.status = 'whatever';
    await r.save({ validateBeforeSave: false });
    assert.equal((await Req.findById(r._id)).status, 'whatever');
  });
});

describe('deleting and bulk inserts', () => {
  it('deleteMany, deleteOne and findByIdAndDelete', async () => {
    await Thing.deleteMany({});
    const docs = await Thing.insertMany([{ name: 'd1' }, { name: 'd2' }, { name: 'd3' }, { name: 'd4' }]);
    assert.equal(docs.length, 4);
    assert.match(String(docs[0]._id), /^[0-9a-f]{24}$/);

    assert.equal((await Thing.deleteOne({ name: 'd1' })).deletedCount, 1);
    const removed = await Thing.findByIdAndDelete(docs[1]._id);
    assert.equal(removed.name, 'd2');
    assert.equal(await Thing.findById(docs[1]._id), null);
    assert.equal((await Thing.deleteMany({ name: { $in: ['d3', 'd4'] } })).deletedCount, 2);
    assert.equal(await Thing.countDocuments({}), 0);
    assert.equal((await Thing.deleteMany({})).deletedCount, 0);
  });

  it('runs pre(insertMany) hooks over the raw input before building documents', async () => {
    const created = await Place.insertMany([{ name: 'A', lat: 28.6, lng: 77.2 }, { name: 'B' }]);
    assert.deepEqual(created[0].coordinates.coordinates, [77.2, 28.6]);
    assert.equal(created[1].coordinates.type, 'Point');
    const stored = await Place.findOne({ name: 'A' }).lean();
    assert.deepEqual(stored.coordinates.coordinates, [77.2, 28.6]);
  });
});

describe('TTL clean-up', () => {
  it('removes documents whose expiresAt has passed', async () => {
    await Req.deleteMany({});
    const driverId = new mongoose.Types.ObjectId();
    await Req.create({ driverId, expiresAt: new Date(Date.now() - 60 * 1000) });
    await Req.create({ driverId, expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    await Req.create({ driverId });
    assert.equal(await Req.countDocuments({}), 3);

    await mongoose.connection.sweepExpired();
    assert.equal(await Req.countDocuments({}), 2);
    assert.equal(await Req.countDocuments({ expiresAt: { $lt: new Date() } }), 0);
  });
});
