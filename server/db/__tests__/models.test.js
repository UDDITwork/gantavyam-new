'use strict';

/**
 * Exercises the project's real models (models/*.js) on the new database layer, using the same
 * calls the controllers, routes and sockets make.
 */

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mongoose, connectTemp, cleanup } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const Admin = require('../../models/Admin');
const BoothQueue = require('../../models/BoothQueue');
const Driver = require('../../models/Driver');
const DriverOfflineRequest = require('../../models/DriverOfflineRequest');
const DriverOnlineRequest = require('../../models/DriverOnlineRequest');
const FareConfig = require('../../models/FareConfig');
const MetroStation = require('../../models/MetroStation');
const PickupLocation = require('../../models/PickupLocation');
const RideHistory = require('../../models/RideHistory');
const RideRequest = require('../../models/RideRequest');
const SmsLog = require('../../models/SmsLog');
const User = require('../../models/User');

let file;
before(async () => {
  file = await connectTemp('models');
});
after(async () => {
  await cleanup(file);
});

const driverData = (n, extra = {}) => ({
  fullName: `Driver ${n}`,
  mobileNo: `98765432${String(10 + n)}`,
  aadhaarNo: `1234567890${String(10 + n)}`,
  aadhaarPhotoFront: 'front.jpg',
  aadhaarPhotoBack: 'back.jpg',
  driverSelfie: 'selfie.jpg',
  vehicleNo: `DL1AB12${String(10 + n)}`,
  vehicleType: 'auto',
  registrationCertificatePhoto: 'rc.jpg',
  bankDetails: { accountHolderName: 'Holder', accountNumber: '123456789012', ifscCode: 'SBIN0001234', bankName: 'SBI' },
  drivingLicenseNo: 'DL-LIC-1',
  drivingLicensePhoto: 'dl.jpg',
  password: 'driverpass',
  ...extra,
});

describe('Admin', () => {
  it('hashes passwords, assigns role permissions and matches passwords', async () => {
    const admin = await Admin.create({ name: 'Boss', email: 'boss@example.com', password: 'secret123', role: 'fleet-manager' });
    assert.deepEqual(admin.permissions, ['rides:view', 'drivers:view', 'drivers:create', 'queue:view']);
    const withPassword = await Admin.findById(admin._id).select('+password');
    assert.notEqual(withPassword.password, 'secret123');
    assert.equal(await withPassword.matchPassword('secret123'), true);
    assert.equal(await withPassword.matchPassword('wrong'), false);
    assert.equal((await Admin.findById(admin._id)).password, undefined);
  });

  it('creates the default admin from the environment and refreshes its password', async () => {
    process.env.DEFAULT_ADMIN_EMAIL = 'default-admin@example.com';
    process.env.DEFAULT_ADMIN_PASSWORD = 'first-password';
    await Admin.createDefaultAdmin();
    const first = await Admin.findOne({ email: 'default-admin@example.com' }).select('+password');
    assert.ok(first);
    assert.equal(first.role, 'admin');
    assert.ok(first.permissions.includes('admins:manage'));
    assert.equal(await first.matchPassword('first-password'), true);

    process.env.DEFAULT_ADMIN_PASSWORD = 'second-password';
    await Admin.createDefaultAdmin();
    assert.equal(await Admin.countDocuments({ email: 'default-admin@example.com' }), 1);
    const second = await Admin.findOne({ email: 'default-admin@example.com' }).select('+password');
    assert.equal(await second.matchPassword('second-password'), true);
  });

  it('brings stale permissions up to date', async () => {
    const admin = await Admin.create({ name: 'Exec', email: 'exec@example.com', password: 'secret123', role: 'executive-manager' });
    await Admin.updateOne({ _id: admin._id }, { $set: { permissions: ['drivers:view'] } });
    await Admin.updateAdminPermissions();
    const fresh = await Admin.findById(admin._id);
    assert.ok(fresh.permissions.includes('rides:manual_booking'));
    assert.equal(fresh.permissions.includes('financial:view'), false);
    assert.equal((await Admin.findById(admin._id).select('+password')).password.startsWith('$2'), true); // untouched hash
  });

  it('validates role and email', async () => {
    await assert.rejects(Admin.create({ name: 'x', email: 'bad', password: 'secret123' }), /Please add a valid email/);
    await assert.rejects(Admin.create({ name: 'x', email: 'x@example.com', password: 'secret123', role: 'god' }), /not a valid enum value for path `role`/);
  });
});

describe('User', () => {
  it('registers, finds by phone, and matches passwords like the auth controller does', async () => {
    const user = await User.create({ name: 'Rider', phone: '9000000001', password: 'rider-pass' });
    assert.equal(user.role, 'user');
    assert.equal(user.rideStatistics.favoriteVehicleType, 'auto');
    assert.equal(user.preferences.notificationSettings.rideUpdates, true);

    const found = await User.findOne({ phone: '9000000001' }).select('+password');
    assert.equal(await found.matchPassword('rider-pass'), true);
    assert.equal(await found.matchPassword('nope'), false);
    found.lastLogin = new Date();
    found.firstLogin = false;
    await found.save();
    const reread = await User.findById(user._id).select('+password');
    assert.equal(await reread.matchPassword('rider-pass'), true); // not double-hashed
    assert.equal(reread.firstLogin, false);
  });

  it('enforces the unique phone and optional unique email', async () => {
    await assert.rejects(User.create({ name: 'Dup', phone: '9000000001', password: 'rider-pass' }), (e) => e.code === 11000 && e.keyPattern.phone === 1);
    await User.create({ name: 'A', phone: '9000000002', password: 'rider-pass' });
    await User.create({ name: 'B', phone: '9000000003', password: 'rider-pass' });
    await User.create({ name: 'C', phone: '9000000004', password: 'rider-pass', email: 'c@example.com' });
    await assert.rejects(User.create({ name: 'D', phone: '9000000005', password: 'rider-pass', email: 'c@example.com' }), (e) => e.code === 11000 && e.keyPattern.email === 1);
  });

  it('syncIndexes resolves', async () => {
    await User.syncIndexes();
  });
});

describe('Driver', () => {
  it('registers a driver with all the validations, geo defaults and queue fields', async () => {
    const driver = await Driver.create(driverData(1));
    assert.equal(driver.isVerified, false);
    assert.equal(driver.connectionStatus, 'offline');
    assert.equal(driver.inQueue, false);
    assert.equal(driver.currentMetroBooth, null);
    assert.equal(driver.queuePosition, null);
    assert.deepEqual(driver.location.coordinates, [0, 0]);
    assert.equal(driver.location.type, 'Point');
    assert.equal(driver.currentRide, null);
    assert.equal(driver.bankDetails.bankName, 'SBI');
    assert.equal((await Driver.findById(driver._id)).password, undefined);
    assert.equal(await (await Driver.findById(driver._id).select('+password')).matchPassword('driverpass'), false); // stored plain: no hashing hook on Driver
  });

  it('reports field-level validation errors the way the registration controller reads them', async () => {
    await assert.rejects(Driver.create(driverData(2, { mobileNo: '123', aadhaarNo: '12' })), (err) => {
      assert.equal(err.name, 'ValidationError');
      assert.equal(err.errors.mobileNo.message, 'Mobile number must be exactly 10 digits');
      assert.equal(err.errors.aadhaarNo.message, 'Aadhaar number must be exactly 12 digits');
      return true;
    });
    await assert.rejects(Driver.create(driverData(3, { bankDetails: { accountHolderName: 'x', accountNumber: 'abc', ifscCode: 'bad', bankName: 'b' } })), (err) => {
      assert.match(err.errors['bankDetails.accountNumber'].message, /9-18 digits/);
      assert.match(err.errors['bankDetails.ifscCode'].message, /valid format/);
      return true;
    });
  });

  it('reports duplicate keys with keyValue', async () => {
    await Driver.create(driverData(4));
    await assert.rejects(Driver.create(driverData(4, { aadhaarNo: '999999999999', vehicleNo: 'DL9ZZ9999' })), (e) => e.code === 11000 && Object.keys(e.keyValue)[0] === 'mobileNo');
  });

  it('supports queue updates the socket code performs', async () => {
    const driver = await Driver.create(driverData(5));
    const updated = await Driver.findByIdAndUpdate(
      driver._id,
      { $set: { isOnline: true, inQueue: true, connectionStatus: 'connected', currentMetroBooth: 'Rajiv Chowk', queuePosition: 1, queueEntryTime: new Date(), 'location.coordinates': [77.2, 28.6], 'location.lastUpdated': new Date() } },
      { new: true }
    );
    assert.equal(updated.inQueue, true);
    assert.deepEqual(updated.location.coordinates, [77.2, 28.6]);
    assert.equal(await Driver.countDocuments({ inQueue: true, currentMetroBooth: 'Rajiv Chowk' }), 1);
    const queued = await Driver.find({ currentMetroBooth: 'Rajiv Chowk', inQueue: true, isVerified: false }).sort({ queuePosition: 1 }).select('fullName queuePosition').lean();
    assert.equal(queued[0].queuePosition, 1);
  });
});

describe('RideRequest and RideHistory', () => {
  let user;
  let driver;
  before(async () => {
    user = await User.findOne({ phone: '9000000001' });
    driver = await Driver.findOne({ mobileNo: driverData(1).mobileNo });
  });

  const rideData = (n, extra = {}) => ({
    userId: user._id,
    userName: 'Rider',
    userPhone: '9000000001',
    distance: 4.2,
    fare: 120,
    estimatedFare: 120,
    vehicleType: 'auto',
    rideId: `RIDE-${n}`,
    pickupLocation: { boothName: 'Rajiv Chowk', latitude: 28.63, longitude: 77.21 },
    dropLocation: { address: 'CP', latitude: 28.64, longitude: 77.22 },
    ...extra,
  });

  it('creates rides with defaults and enforces status rules and transitions', async () => {
    const ride = await RideRequest.create(rideData(1));
    assert.equal(ride.status, 'pending');
    assert.equal(ride.paymentStatus, 'pending');
    assert.equal(ride.bookingSource, 'app');
    assert.equal(ride.driverFare, null);

    ride.status = 'driver_assigned';
    await assert.rejects(ride.save(), /Cannot assign driver status without a driver/);

    ride.driverId = driver._id;
    await ride.save();
    await ride.updateStatus('ride_started');
    assert.ok((await RideRequest.findById(ride._id)).rideStartedAt instanceof Date);
    await ride.updateStatus('ride_ended');
    await ride.updateStatus('completed');
    const done = await RideRequest.findById(ride._id);
    assert.equal(done.status, 'completed');
    assert.ok(done.completedAt instanceof Date);
    assert.ok(done.rideEndedAt instanceof Date);

    assert.throws(() => done.updateStatus('pending'), /Invalid status transition from completed to pending/);
  });

  it('rejects invalid direct transitions and duplicate ride ids', async () => {
    const ride = await RideRequest.create(rideData(2));
    ride.status = 'completed';
    await assert.rejects(ride.save(), /Invalid status transition from pending to completed/);
    await assert.rejects(RideRequest.create(rideData(2)), (e) => e.code === 11000 && e.keyPattern.rideId === 1);
  });

  it('allows many rides without the sparse unique booking ids', async () => {
    await RideRequest.create(rideData(3));
    await RideRequest.create(rideData(4));
    await RideRequest.create(rideData(5, { bookingId: 'MNL1' }));
    await assert.rejects(RideRequest.create(rideData(6, { bookingId: 'MNL1' })), (e) => e.code === 11000);
  });

  it('answers the queries the admin dashboards run', async () => {
    const pending = await RideRequest.find({ status: 'pending' }).populate('userId', 'name phone').sort({ createdAt: -1 }).limit(10);
    assert.ok(pending.length >= 1);
    assert.equal(pending[0].userId.name, 'Rider');
    const counts = await RideRequest.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
    assert.ok(counts.find((c) => c._id === 'completed'));
    assert.ok((await RideRequest.countDocuments({ 'pickupLocation.boothName': 'Rajiv Chowk' })) >= 3);
  });

  it('stores ride history documents', async () => {
    const history = await RideHistory.create({
      userId: user._id,
      driverId: driver._id,
      rideId: 'RIDE-1',
      boothRideNumber: 'RC-0001',
      vehicleType: 'auto',
      distance: 4.2,
      estimatedFare: 120,
      actualFare: 120,
      status: 'completed',
      timestamps: { requested: new Date(), rideStarted: new Date(), rideEnded: new Date() },
      userRating: { rating: 5, feedback: 'great' },
    });
    const reread = await RideHistory.findById(history._id).lean();
    assert.equal(reread.timestamps.requested instanceof Date, true);
    assert.equal(reread.userRating.rating, 5);
    assert.equal(reread.paymentStatus, 'collected');
    await assert.rejects(RideHistory.create({ userId: user._id, rideId: 'RIDE-X' }), /validation failed/);
  });
});

describe('BoothQueue', () => {
  it('assigns queue numbers and tracks ride states', async () => {
    const code = BoothQueue.getBoothCode('Rajiv Chowk');
    assert.equal(code, 'RAJV');
    const queue = await BoothQueue.create({ boothName: 'Rajiv Chowk', boothCode: code, date: '2026-02-02' });
    const a = new mongoose.Types.ObjectId();
    const b = new mongoose.Types.ObjectId();
    const first = queue.addToQueue(a);
    queue.addToQueue(b);
    assert.equal(first.queueNumber, 'RAJV-20260202-Q001');
    await queue.save();

    const loaded = await BoothQueue.findOne({ boothName: 'Rajiv Chowk', date: '2026-02-02' });
    assert.equal(loaded.updateRideStatus(a, 'in_progress'), true);
    assert.equal(loaded.currentlyServing, 1);
    await loaded.save();
    const status = (await BoothQueue.findById(queue._id)).getQueueStatus();
    assert.equal(status.queuedCount, 1);
    assert.equal(status.inProgressCount, 1);
    assert.equal(status.nextQueueNumber, 3);
    assert.ok((await BoothQueue.findById(queue._id)).lastUpdated instanceof Date);
    await assert.rejects(BoothQueue.create({ boothName: 'Rajiv Chowk', boothCode: 'RAJV', date: '2026-02-02' }), (e) => e.code === 11000);
    assert.equal((await BoothQueue.find({ 'activeRides.rideId': a })).length, 1);
  });
});

describe('Driver online / offline requests', () => {
  it('manages approval requests with their statics and methods', async () => {
    const driver = await Driver.findOne({ mobileNo: driverData(1).mobileNo });
    const admin = await Admin.findOne({ email: 'boss@example.com' });

    const request = await DriverOnlineRequest.create({
      driverId: driver._id,
      driverName: driver.fullName,
      driverPhone: driver.mobileNo,
      boothName: 'Rajiv Chowk',
      vehicleType: 'auto',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    assert.equal(request.status, 'pending');
    assert.equal(await DriverOnlineRequest.getPendingCount(), 1);
    assert.equal(await DriverOnlineRequest.hasPendingRequest(driver._id), true);
    assert.equal((await DriverOnlineRequest.getPendingByBooth('Rajiv Chowk')).length, 1);

    await request.approve(admin._id, admin.name);
    const approved = await DriverOnlineRequest.findById(request._id);
    assert.equal(approved.status, 'approved');
    assert.equal(String(approved.processedBy), String(admin._id));
    assert.equal(await DriverOnlineRequest.hasPendingRequest(driver._id), false);

    const offline = await DriverOfflineRequest.create({
      driverId: driver._id,
      driverName: driver.fullName,
      driverPhone: driver.mobileNo,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    assert.equal(offline.reason, 'Driver requested to go offline');
    await offline.reject(admin._id, admin.name, 'busy');
    assert.equal((await DriverOfflineRequest.findById(offline._id)).rejectionReason, 'busy');
  });

  it('upserts a single pending request atomically (socket handler pattern)', async () => {
    const driver = await Driver.findOne({ mobileNo: driverData(5).mobileNo });
    const run = () =>
      DriverOnlineRequest.findOneAndUpdate(
        { driverId: driver._id, status: 'pending' },
        {
          $setOnInsert: {
            driverId: driver._id,
            driverName: driver.fullName,
            driverPhone: driver.mobileNo,
            driverPhoto: driver.driverSelfie,
            boothName: 'Hauz Khas Metro Gate No 1',
            vehicleType: 'auto',
            location: undefined,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            requestedAt: new Date(),
            status: 'pending',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    const results = await Promise.all([run(), run(), run(), run(), run()]);
    assert.equal(new Set(results.map((r) => String(r._id))).size, 1);
    assert.equal(await DriverOnlineRequest.countDocuments({ driverId: driver._id, status: 'pending' }), 1);
    assert.deepEqual(results[0].location.coordinates, [0, 0]);
  });

  it('expires pending requests with updateMany', async () => {
    const driver = await Driver.findOne({ mobileNo: driverData(4).mobileNo });
    await DriverOnlineRequest.create({
      driverId: driver._id,
      driverName: 'x',
      driverPhone: '1',
      boothName: 'b',
      vehicleType: 'bike',
      expiresAt: new Date(Date.now() - 1000),
    });
    const result = await DriverOnlineRequest.updateMany({ status: 'pending', expiresAt: { $lt: new Date() } }, { $set: { status: 'expired', processedAt: new Date() } });
    assert.ok(result.modifiedCount >= 1);
    const expired = await DriverOnlineRequest.find({ status: 'expired' }).select('_id');
    assert.ok(expired.length >= 1);
  });
});

describe('FareConfig', () => {
  it('creates the default config once and bumps the version on save', async () => {
    const first = await FareConfig.getActiveConfig();
    assert.equal(first.nightCharge.userPercentage, 30);
    assert.equal(first.version, 1);
    const second = await FareConfig.getActiveConfig();
    assert.equal(String(second._id), String(first._id));
    second.nightCharge.userPercentage = 35;
    await second.save();
    const third = await FareConfig.getActiveConfig();
    assert.equal(third.nightCharge.userPercentage, 35);
    assert.equal(third.version, 2);
    await assert.rejects(FareConfig.create({ nightCharge: { startHour: 99 } }), /startHour/);
  });
});

describe('MetroStation and PickupLocation', () => {
  it('finds stations by line and nearest', async () => {
    await MetroStation.insertMany([
      { id: 1, name: 'Rajiv Chowk', line: 'Blue', location: { coordinates: [77.2189, 28.6328] }, lat: 28.6328, lng: 77.2189 },
      { id: 2, name: 'Kashmere Gate', line: 'Red', location: { coordinates: [77.2288, 28.6675] }, lat: 28.6675, lng: 77.2288 },
      { id: 3, name: 'Noida City Centre', line: 'Blue', location: { coordinates: [77.3562, 28.5745] }, lat: 28.5745, lng: 77.3562 },
    ]);
    assert.deepEqual((await MetroStation.findByLine('Blue')).map((s) => s.name).sort(), ['Noida City Centre', 'Rajiv Chowk']);
    assert.deepEqual((await MetroStation.findNearest(28.633, 77.219, 2000)).map((s) => s.name), ['Rajiv Chowk']);
    // Kashmere Gate is about 4 km away: inside a 5 km radius, listed after the closer station
    assert.deepEqual((await MetroStation.findNearest(28.633, 77.219, 5000)).map((s) => s.name), ['Rajiv Chowk', 'Kashmere Gate']);
    const station = await MetroStation.findOne({ id: 1 });
    await station.incrementOnlineDrivers();
    assert.equal((await MetroStation.findOne({ id: 1 })).onlineDrivers, 1);
    await assert.rejects(MetroStation.create({ id: 1, name: 'dup', line: 'Blue', location: { coordinates: [1, 1] }, lat: 1, lng: 1 }), (e) => e.code === 11000);
  });

  it('seeds locations with insertMany, syncs coordinates and serves search/nearest', async () => {
    await PickupLocation.createIndexes();
    await PickupLocation.insertMany([
      { id: 'rajiv', name: 'Rajiv Chowk', type: 'metro', address: 'Connaught Place', lat: 28.6328, lng: 77.2189, line: 'blue', priority: 9 },
      { id: 'ndls', name: 'New Delhi Railway Station', type: 'railway', address: 'Paharganj', lat: 28.6431, lng: 77.2197, priority: 8 },
      { id: 'igia', name: 'IGI Airport T3', type: 'airport', address: 'Palam', lat: 28.5562, lng: 77.1, priority: 10, isActive: false },
    ]);
    const rajiv = await PickupLocation.findOne({ id: 'rajiv' });
    assert.deepEqual(rajiv.coordinates.coordinates, [77.2189, 28.6328]);
    assert.deepEqual(rajiv.location, { lat: 28.6328, lng: 77.2189 }); // virtual

    assert.deepEqual((await PickupLocation.findByType('metro')).map((l) => l.id), ['rajiv']);
    assert.deepEqual((await PickupLocation.searchLocations('railway')).map((l) => l.id), ['ndls']);
    assert.deepEqual((await PickupLocation.searchLocations('connaught')).map((l) => l.id), ['rajiv']);
    assert.deepEqual((await PickupLocation.findNearest(28.633, 77.219, 500)).map((l) => l.id), ['rajiv']);
    assert.deepEqual((await PickupLocation.findNearest(28.633, 77.219, 5000)).map((l) => l.id), ['rajiv', 'ndls']); // nearest first; inactive airport excluded
    assert.deepEqual((await PickupLocation.getPopularLocations(null, 5)).map((l) => l.id), ['rajiv', 'ndls']);
    assert.deepEqual((await PickupLocation.findMetroByLine('BLUE')).map((l) => l.id), ['rajiv']);

    const json = JSON.parse(JSON.stringify(rajiv));
    assert.equal(json.id, 'rajiv');
    assert.equal(json.stats.totalRides, 0);
    assert.equal(json.location, undefined);

    await rajiv.incrementRideCount();
    await rajiv.incrementRideCount();
    const counted = await PickupLocation.findOne({ id: 'rajiv' });
    assert.equal(counted.totalRides, 2);
    assert.equal(counted.dailyRideCounter.count, 2);
    await counted.updateWaitTime(15);
    assert.equal((await PickupLocation.findOne({ id: 'rajiv' })).avgWaitTime, Math.round(0.3 * 15 + 0.7 * 5));
  });
});

describe('SmsLog', () => {
  it('logs messages, lists history with populated admin, and aggregates stats', async () => {
    const admin = await Admin.findOne({ email: 'boss@example.com' });
    const rideId = new mongoose.Types.ObjectId();
    const a = await SmsLog.logSMS({ rideId, phoneNumber: '+919876543210', messageType: 'booking_confirmation', message: 'hi', status: 'success', adminId: admin._id, adminName: admin.name, cost: 5 });
    await SmsLog.logSMS({ rideId, phoneNumber: '+919876543210', message: 'again', status: 'failed', adminId: admin._id, cost: 2 });
    assert.equal(a.formattedPhone, '+91 98765 43210');
    assert.equal(await SmsLog.logSMS({ phoneNumber: 'missing ride id' }), null);

    const history = await SmsLog.getRideHistory(rideId);
    assert.equal(history.length, 2);
    assert.equal(history[0].adminId.name, 'Boss');

    const stats = await SmsLog.getAdminStats(String(admin._id), 30);
    const byStatus = Object.fromEntries(stats.map((s) => [s._id, s]));
    assert.equal(byStatus.success.count, 1);
    assert.equal(byStatus.success.totalCost, 5);
    assert.equal(byStatus.failed.totalCost, 2);
  });
});
