'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');

const { ObjectId } = mongoose.Schema.Types;
let file;

const Agg = mongoose.model(
  'Agg',
  new mongoose.Schema(
    {
      driverId: { type: ObjectId },
      status: String,
      paymentStatus: String,
      vehicleType: String,
      pickupLocation: { boothName: String, latitude: Number },
      fare: Number,
      customerFare: { type: Number, default: null },
      estimatedFare: Number,
      driverFare: { type: Number, default: null },
      actualFare: Number,
      totalFare: Number,
      paymentCollectedAt: Date,
      rideStartTime: Date,
      rideEndTime: Date,
      timestamps: { requested: Date },
      createdAt: Date,
    },
    { timestamps: false }
  )
);
const Owner = mongoose.model('Owner', new mongoose.Schema({ name: String, pendingRef: { type: ObjectId } }));
const Ref = mongoose.model('Ref', new mongoose.Schema({ label: String }));

const at = (iso) => new Date(iso);
const bySort = (list, key) => list.slice().sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));

let driverA;

before(async () => {
  file = await connectTemp('aggregate');
  driverA = new mongoose.Types.ObjectId();
  const driverB = new mongoose.Types.ObjectId();
  await Agg.insertMany([
    { driverId: driverA, status: 'completed', paymentStatus: 'collected', vehicleType: 'auto', pickupLocation: { boothName: 'Rajiv Chowk' }, fare: 100, customerFare: 120, estimatedFare: 110, driverFare: 90, actualFare: 120, totalFare: 120, createdAt: at('2026-01-05T10:00:00Z'), paymentCollectedAt: at('2026-01-05T11:00:00Z'), rideStartTime: at('2026-01-05T10:10:00Z'), rideEndTime: at('2026-01-05T10:40:00Z'), timestamps: { requested: at('2026-01-05T09:55:00Z') } },
    { driverId: driverA, status: 'completed', paymentStatus: 'collected', vehicleType: 'bike', pickupLocation: { boothName: 'Rajiv Chowk' }, fare: 50, estimatedFare: 55, actualFare: 55, totalFare: 55, createdAt: at('2026-01-05T15:00:00Z'), paymentCollectedAt: at('2026-01-05T15:30:00Z'), rideStartTime: at('2026-01-05T15:05:00Z'), rideEndTime: at('2026-01-05T15:25:00Z') },
    { driverId: driverB, status: 'completed', paymentStatus: 'pending', vehicleType: 'auto', pickupLocation: { boothName: 'Hauz Khas' }, fare: 80, customerFare: 95, estimatedFare: 90, driverFare: 70, actualFare: 95, totalFare: 95, createdAt: at('2026-01-06T08:00:00Z') },
    { driverId: driverA, status: 'cancelled', paymentStatus: 'pending', vehicleType: 'car', pickupLocation: { boothName: 'Hauz Khas' }, fare: 300, estimatedFare: 310, createdAt: at('2026-01-20T12:00:00Z') },
    { status: 'ride_ended', vehicleType: 'auto', pickupLocation: { boothName: 'Hauz Khas' }, fare: 60, estimatedFare: 60, totalFare: 60, createdAt: at('2026-02-03T12:00:00Z') },
    { status: 'completed', vehicleType: 'auto', fare: 10, estimatedFare: 10, createdAt: at('2026-02-04T12:00:00Z') },
  ]);

  const ref = await Ref.create({ label: 'expired request' });
  await Owner.create({ name: 'with ref', pendingRef: ref._id });
  await Owner.create({ name: 'without ref' });
});
after(async () => {
  await cleanup(file);
});

describe('pipelines used by the admin dashboards', () => {
  it('counts by status', async () => {
    const result = await Agg.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    assert.deepEqual(bySort(result, '_id'), [
      { _id: 'cancelled', count: 1 },
      { _id: 'completed', count: 4 },
      { _id: 'ride_ended', count: 1 },
    ]);
  });

  it('groups by a nested field and by a whole sub-object', async () => {
    const byBooth = await Agg.aggregate([{ $group: { _id: '$pickupLocation.boothName', count: { $sum: 1 } } }]);
    assert.deepEqual(Object.fromEntries(byBooth.map((r) => [String(r._id), r.count])), { 'Hauz Khas': 3, 'Rajiv Chowk': 2, null: 1 });
    const byObject = await Agg.aggregate([
      { $match: { pickupLocation: { $exists: true, $ne: null } } },
      { $group: { _id: '$pickupLocation', totalRides: { $sum: 1 } } },
    ]);
    assert.equal(byObject.length, 2);
    assert.deepEqual(byObject.map((r) => r._id.boothName).sort(), ['Hauz Khas', 'Rajiv Chowk']);
  });

  it('computes completion rates with $cond, $addFields, $divide, $multiply, sort and limit', async () => {
    const result = await Agg.aggregate([
      { $match: { createdAt: { $gte: at('2026-01-01T00:00:00Z') }, pickupLocation: { $exists: true, $ne: null } } },
      {
        $group: {
          _id: '$pickupLocation.boothName',
          totalRides: { $sum: 1 },
          completedRides: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          cancelledRides: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
          avgFare: { $avg: '$totalFare' },
        },
      },
      { $addFields: { completionRate: { $cond: [{ $eq: ['$totalRides', 0] }, 0, { $multiply: [{ $divide: ['$completedRides', '$totalRides'] }, 100] }] } } },
      { $sort: { totalRides: -1 } },
      { $limit: 20 },
    ]);
    const rajiv = result.find((r) => r._id === 'Rajiv Chowk');
    assert.equal(rajiv.totalRides, 2);
    assert.equal(rajiv.completedRides, 2);
    assert.equal(rajiv.completionRate, 100);
    assert.equal(rajiv.avgFare, 87.5);
    const hauz = result.find((r) => r._id === 'Hauz Khas');
    assert.equal(hauz.totalRides, 3);
    assert.equal(hauz.cancelledRides, 1);
    assert.ok(Math.abs(hauz.completionRate - 33.3333333) < 1e-4);
    assert.equal(result[0]._id, 'Hauz Khas'); // sorted by totalRides desc
  });

  it('groups by calendar day with date operators and sorts by the compound _id', async () => {
    const result = await Agg.aggregate([
      { $match: { status: 'completed', paymentStatus: 'collected', paymentCollectedAt: { $gte: at('2026-01-01T00:00:00Z') } } },
      {
        $group: {
          _id: { year: { $year: '$paymentCollectedAt' }, month: { $month: '$paymentCollectedAt' }, day: { $dayOfMonth: '$paymentCollectedAt' } },
          collected: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    ]);
    // ride 1 has customerFare 120, ride 2 has customerFare null -> falls back to estimatedFare 55
    assert.deepEqual(result, [{ _id: { year: 2026, month: 1, day: 5 }, collected: 175, count: 2 }]);
  });

  it('formats dates with $dateToString', async () => {
    const result = await Agg.aggregate([
      { $match: { createdAt: { $gte: at('2026-01-01T00:00:00Z') } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    assert.deepEqual(result.map((r) => [r._id, r.count]), [
      ['2026-01-05', 2],
      ['2026-01-06', 1],
      ['2026-01-20', 1],
      ['2026-02-03', 1],
      ['2026-02-04', 1],
    ]);
  });

  it('computes average duration from date subtraction', async () => {
    const result = await Agg.aggregate([
      { $match: { status: 'completed', rideStartTime: { $exists: true }, rideEndTime: { $exists: true } } },
      { $addFields: { duration: { $subtract: ['$rideEndTime', '$rideStartTime'] } } },
      { $group: { _id: null, avgDuration: { $avg: '$duration' }, count: { $sum: 1 } } },
    ]);
    // 30 minutes and 20 minutes
    assert.deepEqual(result, [{ _id: null, avgDuration: 25 * 60 * 1000, count: 2 }]);
  });

  it('sums driver earnings with nested $ifNull and filters by ObjectId', async () => {
    const result = await Agg.aggregate([
      { $match: { driverId: mongoose.Types.ObjectId(String(driverA)), status: 'completed', createdAt: { $gte: at('2026-01-01T00:00:00Z'), $lte: at('2026-03-01T00:00:00Z') } } },
      { $group: { _id: null, total: { $sum: { $ifNull: ['$driverFare', { $ifNull: ['$fare', '$actualFare'] }] } } } },
    ]);
    // ride 1: driverFare 90; ride 2: driverFare null -> fare 50
    assert.deepEqual(result, [{ _id: null, total: 140 }]);

    const asString = await Agg.aggregate([
      { $match: { driverId: new mongoose.Types.ObjectId(String(driverA)) } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]);
    assert.deepEqual(bySort(asString, '_id'), [{ _id: 'cancelled', n: 1 }, { _id: 'completed', n: 2 }]);
  });

  it('supports $max with an array of values as an expression', async () => {
    const result = await Agg.aggregate([
      { $match: { status: 'completed' } },
      {
        $group: {
          _id: null,
          platformRevenue: {
            $sum: { $max: [0, { $subtract: [{ $ifNull: ['$customerFare', '$estimatedFare'] }, { $ifNull: ['$driverFare', '$fare'] }] }] },
          },
        },
      },
    ]);
    // ride1: 120-90=30, ride2: 55-50=5, ride3: 95-70=25, ride6: 10-10=0
    assert.deepEqual(result, [{ _id: null, platformRevenue: 60 }]);
  });

  it('supports $type inside $cond and a $match after $group', async () => {
    const result = await Agg.aggregate([
      {
        $group: {
          _id: {
            $cond: {
              if: { $type: '$pickupLocation' },
              then: { $cond: { if: { $eq: [{ $type: '$pickupLocation' }, 'object'] }, then: '$pickupLocation.boothName', else: '$pickupLocation' } },
              else: null,
            },
          },
          totalRides: { $sum: 1 },
          lastRide: { $max: '$createdAt' },
        },
      },
      { $match: { _id: { $ne: null, $ne: '' } } },
      { $sort: { totalRides: -1 } },
    ]);
    assert.ok(result.length >= 2);
    assert.equal(result[0]._id, 'Hauz Khas');
    assert.equal(result[0].totalRides, 3);
    assert.ok(result[0].lastRide instanceof Date);
  });

  it('sums a total with no matching documents as an empty result', async () => {
    const result = await Agg.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: at('2030-01-01T00:00:00Z') } } },
      { $group: { _id: null, totalRevenue: { $sum: '$actualFare' } } },
    ]);
    assert.deepEqual(result, []);
  });
});

describe('MongoDB-specific operator semantics', () => {
  const weekOfYearSundayBased = (d) => {
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
    return Math.floor((yday + 7 - d.getUTCDay()) / 7);
  };

  it('$week follows MongoDB (Sunday-based, week 0 before the first Sunday)', async () => {
    const dates = ['2026-01-01', '2026-01-03', '2026-01-04', '2026-01-10', '2026-01-11', '2026-01-15', '2026-02-20', '2026-03-31', '2026-12-31'];
    await Agg.deleteMany({});
    await Agg.insertMany(dates.map((d) => ({ status: 'w', createdAt: at(`${d}T12:00:00Z`) })));
    const result = await Agg.aggregate([
      { $group: { _id: { year: { $year: '$createdAt' }, week: { $week: '$createdAt' } }, rides: { $sum: 1 } } },
    ]);
    const expected = new Map();
    for (const d of dates) {
      const key = weekOfYearSundayBased(at(`${d}T12:00:00Z`));
      expected.set(key, (expected.get(key) || 0) + 1);
    }
    assert.equal(result.length, expected.size);
    for (const row of result) assert.equal(row.rides, expected.get(row._id.week), `week ${row._id.week}`);
    assert.ok(result.some((r) => r._id.week === 0)); // Jan 1 and Jan 3 precede the first Sunday
    assert.ok(result.some((r) => r._id.week === 1)); // Jan 4 - Jan 10
  });

  it('$lookup joins another collection', async () => {
    const result = await Owner.aggregate([
      { $lookup: { from: 'refs', localField: 'pendingRef', foreignField: '_id', as: 'requestInfo' } },
      { $sort: { name: 1 } },
    ]);
    const withRef = result.find((r) => r.name === 'with ref');
    assert.equal(withRef.requestInfo.length, 1);
    assert.equal(withRef.requestInfo[0].label, 'expired request');
    assert.equal(result.find((r) => r.name === 'without ref').requestInfo.length, 0);
  });
});
