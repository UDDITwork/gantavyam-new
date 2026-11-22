'use strict';

/**
 * Requests assigned to one driver (Fleet Manager / manual bookings) must reach the driver's screen even when
 * the first push missed: collectDeliverableRequests decides what is sent when the driver's app connects.
 */

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const RideRequest = require('../../models/RideRequest');
const { collectDeliverableRequests, markDriverNotified, buildDriverRidePayload } = require('../../utils/driverRequestDelivery');

let file;
before(async () => {
  file = await connectTemp('delivery');
});
after(async () => {
  await cleanup(file);
});

const oid = () => new mongoose.Types.ObjectId();
const driverA = oid();
const driverB = oid();
const userId = oid();
let n = 0;

const ride = (extra = {}) => {
  n += 1;
  return RideRequest.create({
    userId,
    userName: 'Rider',
    userPhone: '9000000001',
    distance: 4.2,
    fare: 120,
    driverFare: 100,
    estimatedFare: 120,
    vehicleType: 'auto',
    rideId: `DLV-${n}`,
    bookingId: `DLV-B-${n}`,
    pickupLocation: { boothName: 'Hauz Khas Metro Gate No 1', latitude: 28.5433, longitude: 77.2066 },
    dropLocation: { address: 'Somewhere, Delhi', latitude: 28.6, longitude: 77.2 },
    bookingSource: 'manual',
    status: 'pending_fm',
    targetDriverId: driverA,
    fmAssignedAt: new Date(),
    expiresAt: new Date(Date.now() + 60000),
    ...extra
  });
};
const ids = (rides) => rides.map((r) => String(r._id)).sort();
const minutesAgo = (m) => new Date(Date.now() - m * 60000);

describe('collectDeliverableRequests', () => {
  it('returns a request that never reached the driver and gives it a fresh 60 s window', async () => {
    const r = await ride({ expiresAt: new Date(Date.now() + 5000) }); // only 5 s left
    const found = await collectDeliverableRequests(driverA);
    assert.ok(ids(found).includes(String(r._id)));
    const stored = await RideRequest.findById(r._id);
    const left = stored.expiresAt.getTime() - Date.now();
    assert.ok(left > 55000 && left <= 60000, `window was ${left} ms`);
    assert.equal(stored.isManualBookingExpired, false);
    await RideRequest.deleteMany({});
  });

  it('revives an unconfirmed request whose window already passed (assigned 3 minutes ago)', async () => {
    const r = await ride({ fmAssignedAt: minutesAgo(3), expiresAt: minutesAgo(2) });
    const found = await collectDeliverableRequests(driverA);
    assert.deepEqual(ids(found), [String(r._id)]);
    assert.ok((await RideRequest.findById(r._id)).expiresAt.getTime() > Date.now() + 50000);
    await RideRequest.deleteMany({});
  });

  it('does not revive one the driver already saw once its window is over, but keeps it while it runs', async () => {
    const expired = await ride({ driverNotifiedAt: minutesAgo(2), expiresAt: minutesAgo(1) });
    const running = await ride({ driverNotifiedAt: new Date(), expiresAt: new Date(Date.now() + 30000) });
    const found = await collectDeliverableRequests(driverA);
    assert.deepEqual(ids(found), [String(running._id)]);
    assert.equal((await RideRequest.findById(running._id)).expiresAt.getTime(), running.expiresAt.getTime(), 'a running window is not extended');
    assert.ok((await RideRequest.findById(expired._id)).expiresAt < new Date());
    await RideRequest.deleteMany({});
  });

  it('ignores other drivers, finished rides and old unconfirmed requests', async () => {
    await ride({ targetDriverId: driverB });
    await ride({ status: 'driver_assigned', driverId: driverA });
    await ride({ status: 'cancelled' });
    await ride({ fmAssignedAt: minutesAgo(30), expiresAt: minutesAgo(29) }); // too old to be worth showing
    const mine = await ride();
    assert.deepEqual(ids(await collectDeliverableRequests(driverA)), [String(mine._id)]);
    assert.deepEqual(ids(await collectDeliverableRequests(driverB)).length, 1);
    await RideRequest.deleteMany({});
  });

  it('also serves direct manual bookings (status pending)', async () => {
    const r = await ride({ status: 'pending' });
    assert.deepEqual(ids(await collectDeliverableRequests(driverA)), [String(r._id)]);
    await RideRequest.deleteMany({});
  });
});

describe('markDriverNotified and the payload', () => {
  it('records the confirmation once', async () => {
    const r = await ride();
    await markDriverNotified(r._id);
    const first = (await RideRequest.findById(r._id)).driverNotifiedAt;
    assert.ok(first instanceof Date);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markDriverNotified(r._id);
    assert.equal((await RideRequest.findById(r._id)).driverNotifiedAt.getTime(), first.getTime());
  });

  it('shows the driver only their own earning', async () => {
    const r = await RideRequest.findOne({});
    const payload = buildDriverRidePayload(r);
    assert.equal(payload.driverFare, 100);
    assert.equal(payload.fare, 100);
    assert.equal(payload.estimatedFare, 100);
    assert.equal(payload.status, 'pending');
    assert.equal(payload.isManualBooking, true);
    assert.ok(!('customerFare' in payload) && !('customerTotalFare' in payload));
    assert.equal(payload.pickupLocation.boothName, 'Hauz Khas Metro Gate No 1');
  });
});
