'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');
const { normalizeFilter, translateFilter } = require('../filter');

const { ObjectId } = mongoose.Schema.Types;
let file;

const QUser = mongoose.model('QUser', new mongoose.Schema({ name: String, phone: String }));
const QDriver = mongoose.model(
  'QDriver',
  new mongoose.Schema({
    fullName: String,
    mobileNo: String,
    vehicleNo: String,
    rating: { type: Number, default: 0 },
    password: { type: String, select: false },
  })
);

const RideSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'QUser', required: true },
    driverId: { type: ObjectId, ref: 'QDriver' },
    status: { type: String, default: 'pending' },
    vehicleType: String,
    fare: Number,
    isManual: { type: Boolean, default: false },
    pickupLocation: { boothName: String, latitude: Number, longitude: Number },
    tags: [String],
    expiresAt: { type: Date, default: null },
    note: String,
  },
  { timestamps: true }
);
RideSchema.index({ status: 1, createdAt: -1 });
const Ride = mongoose.model('Ride', RideSchema);

const QueueSchema = new mongoose.Schema({
  boothName: String,
  date: String,
  activeRides: [
    {
      rideId: { type: ObjectId, ref: 'Ride' },
      queueNumber: String,
      status: { type: String, default: 'queued' },
    },
  ],
});
const Queue = mongoose.model('Queue', QueueSchema);

const StationSchema = new mongoose.Schema({
  name: String,
  isActive: { type: Boolean, default: true },
  location: { type: { type: String, default: 'Point' }, coordinates: [Number] },
});
StationSchema.statics.findNearest = function findNearest(lat, lng, maxDistance = 5000) {
  return this.find({
    location: { $near: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: maxDistance } },
    isActive: true,
  });
};
const Station = mongoose.model('Station', StationSchema);

let u1;
let u2;
let d1;
let d2;
const rides = {};

before(async () => {
  file = await connectTemp('queries');
  [u1, u2] = await Promise.all([QUser.create({ name: 'Uma', phone: '1' }), QUser.create({ name: 'Vik', phone: '2' })]);
  d1 = await QDriver.create({ fullName: 'Dev', mobileNo: '11', vehicleNo: 'DL1', rating: 4.5, password: 'pw1' });
  d2 = await QDriver.create({ fullName: 'Eka', mobileNo: '22', vehicleNo: 'DL2', rating: 3 });

  const day = (n) => new Date(Date.UTC(2026, 0, n, 10, 0, 0));
  const seed = [
    ['r1', { userId: u1._id, driverId: d1._id, status: 'completed', vehicleType: 'auto', fare: 100, createdAt: day(1), tags: ['night', 'vip'], pickupLocation: { boothName: 'Rajiv Chowk' }, note: 'Urgent pickup' }],
    ['r2', { userId: u1._id, driverId: d2._id, status: 'completed', vehicleType: 'bike', fare: 40, createdAt: day(2), tags: ['night'], pickupLocation: { boothName: 'Hauz Khas' } }],
    ['r3', { userId: u2._id, status: 'pending', vehicleType: 'auto', fare: 70, createdAt: day(3), pickupLocation: { boothName: 'Rajiv Chowk' }, isManual: true, note: 'urgent' }],
    ['r4', { userId: u2._id, driverId: d1._id, status: 'cancelled', vehicleType: 'car', fare: 250, createdAt: day(4), expiresAt: day(20), pickupLocation: { boothName: 'Hauz Khas' } }],
    ['r5', { userId: u2._id, status: 'pending', vehicleType: 'bike', fare: 40, createdAt: day(5), tags: ['vip'] }],
    ['r6', { userId: u1._id, status: 'completed', vehicleType: 'auto', fare: 100, createdAt: day(6), pickupLocation: { boothName: 'Rajiv Chowk' } }],
  ];
  for (const [key, data] of seed) rides[key] = await Ride.create(data);

  await Queue.create({
    boothName: 'Rajiv Chowk',
    date: '2026-01-01',
    activeRides: [{ rideId: rides.r1._id, queueNumber: 'Q1' }, { rideId: rides.r3._id, queueNumber: 'Q2', status: 'in_progress' }],
  });
  await Queue.create({ boothName: 'Hauz Khas', date: '2026-01-01', activeRides: [{ rideId: rides.r2._id, queueNumber: 'Q1' }] });

  await Station.create({ name: 'Near', location: { coordinates: [77.2090, 28.6139] } });
  await Station.create({ name: 'Mid', location: { coordinates: [77.2300, 28.6300] } });
  await Station.create({ name: 'Far', location: { coordinates: [77.5000, 28.9000] } });
  await Station.create({ name: 'Closed', isActive: false, location: { coordinates: [77.2091, 28.6140] } });
});
after(async () => {
  await cleanup(file);
});

const names = (docs) => docs.map((d) => String(d._id));
const idsOf = (...keys) => keys.map((k) => String(rides[k]._id));

describe('filters', () => {
  it('equality, $in, $nin, $ne', async () => {
    assert.deepEqual(names(await Ride.find({ status: 'pending' })), idsOf('r3', 'r5'));
    assert.deepEqual(names(await Ride.find({ status: { $in: ['pending', 'cancelled'] } })), idsOf('r3', 'r4', 'r5'));
    assert.deepEqual(names(await Ride.find({ status: { $nin: ['completed', 'cancelled'] } })), idsOf('r3', 'r5'));
    assert.deepEqual(names(await Ride.find({ status: { $ne: 'completed' } })), idsOf('r3', 'r4', 'r5'));
  });

  it('numeric and date ranges (Date objects and ISO strings)', async () => {
    assert.deepEqual(names(await Ride.find({ fare: { $gte: 100 } })), idsOf('r1', 'r4', 'r6'));
    assert.deepEqual(names(await Ride.find({ fare: { $gt: 40, $lt: 250 } })), idsOf('r1', 'r3', 'r6'));
    const from = new Date(Date.UTC(2026, 0, 3));
    const to = new Date(Date.UTC(2026, 0, 5));
    assert.deepEqual(names(await Ride.find({ createdAt: { $gte: from, $lt: to } })), idsOf('r3', 'r4'));
    assert.deepEqual(names(await Ride.find({ createdAt: { $gte: '2026-01-05' } })), idsOf('r5', 'r6'));
  });

  it('$or, $and and implicit AND', async () => {
    assert.deepEqual(names(await Ride.find({ $or: [{ fare: 250 }, { vehicleType: 'bike' }] })), idsOf('r2', 'r4', 'r5'));
    assert.deepEqual(names(await Ride.find({ $and: [{ status: 'completed' }, { vehicleType: 'auto' }] })), idsOf('r1', 'r6'));
    assert.deepEqual(names(await Ride.find({ status: 'completed', vehicleType: 'auto', fare: { $lte: 100 } })), idsOf('r1', 'r6'));
    assert.deepEqual(
      names(await Ride.find({ status: 'pending', $or: [{ isManual: true }, { fare: 40 }] })),
      idsOf('r3', 'r5')
    );
  });

  it('null, missing and $exists semantics match MongoDB', async () => {
    assert.deepEqual(names(await Ride.find({ driverId: null })), idsOf('r3', 'r5', 'r6'));
    assert.deepEqual(names(await Ride.find({ driverId: { $ne: null } })), idsOf('r1', 'r2', 'r4'));
    assert.deepEqual(names(await Ride.find({ driverId: { $exists: true } })), idsOf('r1', 'r2', 'r4'));
    assert.deepEqual(names(await Ride.find({ driverId: { $exists: false } })), idsOf('r3', 'r5', 'r6'));
    assert.deepEqual(names(await Ride.find({ expiresAt: null })), idsOf('r1', 'r2', 'r3', 'r5', 'r6'));
    assert.deepEqual(names(await Ride.find({ expiresAt: { $lt: new Date(Date.UTC(2026, 1, 1)) } })), idsOf('r4'));
  });

  it('booleans, nested paths and array membership', async () => {
    assert.deepEqual(names(await Ride.find({ isManual: true })), idsOf('r3'));
    assert.equal((await Ride.find({ isManual: false })).length, 5);
    assert.deepEqual(names(await Ride.find({ 'pickupLocation.boothName': 'Hauz Khas' })), idsOf('r2', 'r4'));
    assert.deepEqual(names(await Ride.find({ tags: 'vip' })), idsOf('r1', 'r5'));
    assert.deepEqual(names(await Ride.find({ tags: { $in: ['night'] } })), idsOf('r1', 'r2'));
  });

  it('regex filters in both forms', async () => {
    assert.deepEqual(names(await Ride.find({ note: { $regex: 'urgent', $options: 'i' } })), idsOf('r1', 'r3'));
    assert.deepEqual(names(await Ride.find({ note: /^urgent/ })), idsOf('r3'));
    assert.deepEqual(
      names(await Ride.find({ $or: [{ note: { $regex: 'pickup', $options: 'i' } }, { vehicleType: 'car' }] })),
      idsOf('r1', 'r4')
    );
  });

  it('filters on ids as strings, ObjectId instances and documents', async () => {
    const asString = await Ride.find({ userId: String(u1._id) });
    const asObjectId = await Ride.find({ userId: new mongoose.Types.ObjectId(String(u1._id)) });
    const asDocument = await Ride.find({ userId: u1 });
    assert.deepEqual(names(asString), idsOf('r1', 'r2', 'r6'));
    assert.deepEqual(names(asObjectId), names(asString));
    assert.deepEqual(names(asDocument), names(asString));
    assert.deepEqual(names(await Ride.find({ _id: { $in: [rides.r2._id, rides.r5._id] } })), idsOf('r2', 'r5'));
  });

  it('filters on array-of-subdocument paths', async () => {
    const found = await Queue.find({ 'activeRides.rideId': rides.r3._id });
    assert.deepEqual(found.map((q) => q.boothName), ['Rajiv Chowk']);
    const inProgress = await Queue.find({ 'activeRides.status': 'in_progress' });
    assert.deepEqual(inProgress.map((q) => q.boothName), ['Rajiv Chowk']);
  });

  it('rejects invalid ObjectIds with a CastError (like Mongoose)', async () => {
    await assert.rejects(Ride.findById('not-an-id'), (err) => {
      assert.equal(err.name, 'CastError');
      assert.match(err.message, /Cast to ObjectId failed for value "not-an-id" \(type string\) at path "_id" for model "Ride"/);
      return true;
    });
    assert.equal(await Ride.findById(String(new mongoose.Types.ObjectId())), null);
  });
});

describe('sorting, paging and projection', () => {
  it('sorts by one or several keys and by -field strings', async () => {
    assert.deepEqual(names(await Ride.find().sort({ fare: -1, createdAt: 1 })), idsOf('r4', 'r1', 'r6', 'r3', 'r2', 'r5'));
    assert.deepEqual(names(await Ride.find().sort('-createdAt').limit(2)), idsOf('r6', 'r5'));
    assert.deepEqual(names(await Ride.find().sort({ createdAt: 1 }).skip(2).limit(2)), idsOf('r3', 'r4'));
    assert.equal((await Ride.findOne({ status: 'completed' }).sort('-createdAt'))._id.toString(), String(rides.r6._id));
  });

  it('sorts correctly when the sort key or filter cannot be pushed into SQL', async () => {
    const regexSorted = await Ride.find({ note: { $regex: 'urgent', $options: 'i' } }).sort({ fare: 1 });
    assert.deepEqual(names(regexSorted), idsOf('r3', 'r1'));
    const byNested = await Ride.find({ 'pickupLocation.boothName': { $exists: true } }).sort({ 'pickupLocation.boothName': 1, fare: -1 });
    assert.deepEqual(names(byNested), idsOf('r4', 'r2', 'r1', 'r6', 'r3'));
  });

  it('projects fields: inclusion, exclusion, nested and +select:false', async () => {
    const included = await Ride.findById(rides.r1._id).select('status fare');
    assert.deepEqual(Object.keys(included.toObject()).sort(), ['_id', 'fare', 'status']);

    const excluded = await Ride.findById(rides.r1._id).select('-note -tags').lean();
    assert.equal(excluded.note, undefined);
    assert.equal(excluded.tags, undefined);
    assert.equal(excluded.status, 'completed');

    const nested = await Ride.findById(rides.r1._id).select('pickupLocation.boothName').lean();
    assert.deepEqual(nested.pickupLocation, { boothName: 'Rajiv Chowk' });

    const noPassword = await QDriver.findById(d1._id);
    assert.equal(noPassword.password, undefined);
    assert.equal((await QDriver.findById(d1._id).select('+password')).password, 'pw1');
    assert.equal((await QDriver.findById(d1._id).select('fullName').lean()).password, undefined);
  });

  it('lean() returns plain objects with Date instances', async () => {
    const raw = await Ride.findById(rides.r1._id).lean();
    assert.equal(typeof raw._id, 'string');
    assert.ok(raw.createdAt instanceof Date);
    assert.equal(raw.save, undefined);
  });
});

describe('counting and misc', () => {
  it('counts with pushed-down and in-memory filters', async () => {
    assert.equal(await Ride.countDocuments({ status: 'completed' }), 3);
    assert.equal(await Ride.countDocuments({ note: { $regex: 'urgent', $options: 'i' } }), 2);
    assert.equal(await Ride.countDocuments({}), 6);
    assert.equal(await Ride.estimatedDocumentCount(), 6);
    assert.equal(await Ride.find({ status: 'pending' }).countDocuments(), 2);
  });

  it('distinct() and exists()', async () => {
    assert.deepEqual((await Ride.distinct('vehicleType')).sort(), ['auto', 'bike', 'car']);
    assert.deepEqual((await Ride.distinct('tags')).sort(), ['night', 'vip']);
    assert.ok(await Ride.exists({ status: 'cancelled' }));
    assert.equal(await Ride.exists({ status: 'nope' }), null);
  });
});

describe('populate', () => {
  it('populates single refs with a field list', async () => {
    const ride = await Ride.findById(rides.r1._id).populate('userId', 'name phone').populate('driverId', 'fullName rating');
    assert.equal(ride.userId.name, 'Uma');
    assert.equal(ride.userId.phone, '1');
    assert.equal(ride.userId._id.toString(), String(u1._id));
    assert.equal(ride.driverId.fullName, 'Dev');
    assert.equal(ride.driverId.mobileNo, undefined);
    assert.equal(JSON.parse(JSON.stringify(ride)).userId.name, 'Uma');
  });

  it('populates several paths at once and works with lean', async () => {
    const list = await Ride.find({ status: { $in: ['pending', 'completed'] } }).populate('userId driverId').sort('createdAt').lean();
    assert.equal(list[0].userId.name, 'Uma');
    assert.equal(list[0].driverId.fullName, 'Dev');
    const pending = list.find((r) => r.status === 'pending');
    assert.equal(pending.driverId, undefined); // never set, so nothing to populate
  });

  it('sets dangling references to null', async () => {
    const ghost = await Ride.create({
      userId: u1._id,
      driverId: new mongoose.Types.ObjectId(),
      vehicleType: 'auto',
      fare: 1,
      status: 'expired',
    });
    const populated = await Ride.findById(ghost._id).populate('driverId', 'fullName');
    assert.equal(populated.driverId, null);
    await Ride.deleteOne({ _id: ghost._id });
  });

  it('populates refs inside arrays of sub-documents', async () => {
    const queue = await Queue.findOne({ boothName: 'Rajiv Chowk' }).populate('activeRides.rideId', 'status fare');
    assert.equal(queue.activeRides[0].rideId.status, 'completed');
    assert.equal(queue.activeRides[1].rideId.fare, 70);
    assert.equal(queue.activeRides[0].queueNumber, 'Q1');
  });

  it('keeps the stored references when a populated document is saved', async () => {
    const ride = await Ride.findById(rides.r1._id).populate('userId', 'name');
    ride.note = 'changed after populate';
    await ride.save();
    const raw = await Ride.findById(rides.r1._id).lean();
    assert.equal(raw.note, 'changed after populate');
    assert.equal(raw.userId, String(u1._id));
    await Ride.updateOne({ _id: rides.r1._id }, { $set: { note: 'Urgent pickup' } });
  });

  it('supports document-level populate()', async () => {
    const ride = await Ride.findById(rides.r2._id);
    await ride.populate('driverId', 'fullName');
    assert.equal(ride.driverId.fullName, 'Eka');
  });
});

describe('geospatial $near', () => {
  it('returns active stations within the radius, nearest first', async () => {
    const found = await Station.findNearest(28.6139, 77.2090, 5000);
    assert.deepEqual(found.map((s) => s.name), ['Near', 'Mid']);
    const tight = await Station.findNearest(28.6139, 77.2090, 500);
    assert.deepEqual(tight.map((s) => s.name), ['Near']);
    const limited = await Station.findNearest(28.6139, 77.2090, 100000).limit(2);
    assert.deepEqual(limited.map((s) => s.name), ['Near', 'Mid']);
  });
});

describe('SQL translation', () => {
  const schema = Ride.schema;
  const translate = (filter) => translateFilter(schema, normalizeFilter(schema, filter, 'Ride'));

  it('pushes simple filters into SQL and reports them as exact', () => {
    const t = translate({ status: 'pending', fare: { $gte: 10 }, createdAt: { $lt: new Date('2026-01-01') } });
    assert.equal(t.exact, true);
    assert.match(t.frag.sql, /json_extract\(doc, '\$\.status'\) = \?/);
  });

  it('marks regex and array filters as needing in-memory verification', () => {
    assert.equal(translate({ note: { $regex: 'x' } }).exact, false);
    assert.equal(translate({ tags: 'vip' }).exact, false);
    assert.equal(translate({ $or: [{ status: 'x' }, { note: /y/ }] }).frag, null);
  });
});
