'use strict';

/**
 * End-to-end check of executives (sub-admins of ONE pickup point): a real Express app + Socket.IO server on a
 * throw-away database. The point of every test here: the executive of one pod can neither see nor change anything
 * of the other pod, while admins keep seeing and changing everything.
 */

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { io: connectClient } = require('socket.io-client');
const { mongoose, connectTemp, cleanup } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const Admin = require('../../models/Admin');
const Driver = require('../../models/Driver');
const User = require('../../models/User');
const RideRequest = require('../../models/RideRequest');
const RideHistory = require('../../models/RideHistory');
const DriverOnlineRequest = require('../../models/DriverOnlineRequest');
const { ensurePickupLocations } = require('../../seeders/fixedPickupLocation');
const { initializeSocket, getIO, notifyAdmins } = require('../../socket');
const { registerDriver } = require('../../controllers/driverController');

const HK = 'Hauz Khas Metro Gate No 1';
const PC = 'Patel Chowk Metro Station';

let file;
let server;
let baseUrl;
let tokens = {};
const sockets = [];
const data = {};

const oid = () => new mongoose.Types.ObjectId();

async function api(method, path, token, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = await response.json();
  } catch (error) {
    json = null;
  }
  return { status: response.status, json };
}

async function login(email, password) {
  return api('POST', '/api/auth/admin/login', null, { email, password });
}

let driverCounter = 0;
async function makeDriver(booth, extra = {}) {
  driverCounter += 1;
  const n = String(driverCounter).padStart(2, '0');
  return Driver.create({
    fullName: `Driver ${n}`,
    mobileNo: `98000000${n}`,
    aadhaarNo: `1000000000${n}`,
    aadhaarPhotoFront: '/x.jpg',
    aadhaarPhotoBack: '/x.jpg',
    driverSelfie: '/x.jpg',
    vehicleNo: `DL1ZZ00${n}`,
    vehicleType: 'auto',
    registrationCertificatePhoto: '/x.jpg',
    bankDetails: { accountHolderName: 'Test', accountNumber: '123456789012', ifscCode: 'SBIN0001234', bankName: 'Test Bank' },
    drivingLicenseNo: `DL-${n}`,
    drivingLicensePhoto: '/x.jpg',
    password: 'driverpass1',
    isVerified: true,
    currentMetroBooth: booth,
    ...extra
  });
}

let rideCounter = 0;
async function makeBooking(booth, extra = {}) {
  rideCounter += 1;
  return RideRequest.create({
    userId: data.rider._id,
    userName: 'Rider',
    userPhone: '9000000001',
    distance: 4.2,
    fare: 120,
    driverFare: 100,
    estimatedFare: 120,
    vehicleType: 'auto',
    rideId: `EXE-${rideCounter}`,
    bookingId: `EXE-B-${rideCounter}`,
    pickupLocation: { boothName: booth, latitude: 28.5, longitude: 77.2 },
    dropLocation: { address: 'Somewhere, Delhi', latitude: 28.6, longitude: 77.2 },
    bookingSource: 'manual',
    status: 'pending_fm',
    submittedToFmAt: new Date(),
    startOTP: '1234',
    endOTP: '5678',
    ...extra
  });
}

async function makeHistory(booth, n) {
  return RideHistory.create({
    userId: data.rider._id,
    rideId: `HIST-${booth.slice(0, 2)}-${n}`,
    boothRideNumber: `B-${n}`,
    pickupLocation: { boothName: booth, latitude: 28.5, longitude: 77.2 },
    dropLocation: { address: 'Elsewhere, Delhi', latitude: 28.6, longitude: 77.2 },
    vehicleType: 'auto',
    distance: 5,
    estimatedFare: 130,
    actualFare: 130,
    status: 'completed',
    timestamps: { requested: new Date(Date.now() - n * 3600000), completed: new Date() }
  });
}

function onlineRequest(driver, booth) {
  return DriverOnlineRequest.create({
    driverId: driver._id,
    driverName: driver.fullName,
    driverPhone: driver.mobileNo,
    boothName: booth,
    vehicleType: 'auto',
    status: 'pending',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });
}

// A live connection that remembers every event it receives
function liveClient(token) {
  return new Promise((resolve, reject) => {
    const socket = connectClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
    socket.received = [];
    socket.onAny((event, payload) => socket.received.push({ event, payload }));
    socket.on('connectionSuccess', () => resolve(socket));
    socket.on('connect_error', (error) => reject(error));
    sockets.push(socket);
  });
}

const eventsOf = (socket, name) => socket.received.filter((item) => item.event === name).map((item) => item.payload);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = check();
    if (result) return result;
    await pause(25);
  }
  return null;
}

before(async () => {
  file = await connectTemp('executives');

  const app = express();
  app.use(express.json());
  app.use('/api/drivers', require('../../routes/drivers'));
  app.use('/api/admin', require('../../routes/admin'));
  app.use('/api/admin/online-requests', require('../../routes/admin/driverOnlineRequestRoutes'));
  app.use('/api/auth', require('../../routes/auth'));
  server = http.createServer(app);
  initializeSocket(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  await ensurePickupLocations();

  // The boss (admin), then two executives created the way the admin panel creates them
  await new Admin({ name: 'Boss', email: 'boss@example.com', password: 'BossPass#123', role: 'admin' }).save();
  tokens.boss = (await login('boss@example.com', 'BossPass#123')).json.token;

  const hk = await api('POST', '/api/admin/executives', tokens.boss, {
    name: 'HK Executive', email: 'HK.Exec@Example.com', password: 'HkExecPass#1', assignedPickupLocation: 'HK'
  });
  const pc = await api('POST', '/api/admin/executives', tokens.boss, {
    name: 'PC Executive', email: 'pc.exec@example.com', password: 'PcExecPass#1', assignedPickupLocation: 'PC'
  });
  assert.equal(hk.status, 201);
  assert.equal(pc.status, 201);
  data.hkExecId = hk.json.data._id;
  data.pcExecId = pc.json.data._id;
  tokens.hk = (await login('hk.exec@example.com', 'HkExecPass#1')).json.token;
  tokens.pc = (await login('pc.exec@example.com', 'PcExecPass#1')).json.token;

  // Riders, drivers, bookings, history and online requests of both pods
  data.rider = await User.create({ name: 'Rider', phone: '9000000001', password: 'riderpass1' });
  data.hkDriver = await makeDriver(HK, { isOnline: true, inQueue: true, queuePosition: 1, queueEntryTime: new Date(Date.now() - 600000), connectionStatus: 'connected' });
  data.pcDriver = await makeDriver(PC, { isOnline: true, inQueue: true, queuePosition: 2, queueEntryTime: new Date(Date.now() - 500000), connectionStatus: 'connected' });
  data.hkNewDriver = await makeDriver(null);
  data.pcNewDriver = await makeDriver(null);
  data.pcNewDriver2 = await makeDriver(null);
  data.offlineDriver = await makeDriver(null);

  data.hkBooking = await makeBooking(HK);
  data.pcBooking = await makeBooking(PC);
  await makeHistory(HK, 1);
  await makeHistory(HK, 2);
  await makeHistory(PC, 3);

  data.hkRequest = await onlineRequest(data.hkNewDriver, HK);
  data.pcRequest = await onlineRequest(data.pcNewDriver, PC);
});

after(async () => {
  for (const socket of sockets) socket.close();
  await new Promise((resolve) => server.close(resolve));
  await cleanup(file);
  // Some modules start timers that never stop (lock clean-up, log rotation): end the test process once everything is closed
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
});

describe('executive login', () => {
  it('returns the role, the four-feature permissions and the pod', async () => {
    const result = await login('hk.exec@example.com', 'HkExecPass#1');
    assert.equal(result.status, 200);
    const admin = result.json.admin;
    assert.equal(admin.role, 'executive-manager');
    assert.equal(admin.assignedPickupLocation, 'HK');
    assert.equal(admin.pod.key, 'HK');
    assert.equal(admin.pod.name, HK);
    assert.deepEqual([...admin.permissions].sort(), [
      'drivers:create', 'drivers:view', 'queue:manage', 'queue:view', 'rides:manage', 'rides:manual_booking', 'rides:view'
    ]);
    assert.equal(admin.permissions.includes('financial:view'), false);
    assert.equal(admin.permissions.includes('admins:manage'), false);
  });

  it('accepts the e-mail in any letter case but refuses a wrong password', async () => {
    assert.equal((await login('PC.EXEC@EXAMPLE.COM', 'PcExecPass#1')).status, 200);
    assert.equal((await login('pc.exec@example.com', 'wrong-password')).status, 401);
  });

  it('gives admins no pod', async () => {
    const admin = (await login('boss@example.com', 'BossPass#123')).json.admin;
    assert.equal(admin.role, 'admin');
    assert.equal(admin.pod, null);
    assert.equal(admin.assignedPickupLocation, null);
  });
});

describe('what an executive may call', () => {
  const refused = [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/dashboard/stats'],
    ['GET', '/api/admin/financial/summary'],
    ['GET', '/api/admin/fare/fare-config'],
    ['GET', '/api/admin/executives'],
    ['GET', '/api/admin/queue/booths'],
    ['GET', '/api/admin/rides/analytics/summary'],
    ['GET', '/api/admin/sms-status']
  ];

  for (const [method, path] of refused) {
    it(`refuses ${method} ${path} (the admin may)`, async () => {
      const executive = await api(method, path, tokens.hk);
      assert.equal(executive.status, 403, JSON.stringify(executive.json));
      const admin = await api(method, path, tokens.boss);
      assert.notEqual(admin.status, 403, `admin was refused ${path}`);
    });
  }

  it('refuses a request without a token and one with a made-up token', async () => {
    assert.equal((await api('GET', '/api/admin/rides')).status, 401);
    assert.equal((await api('GET', '/api/admin/rides', 'not-a-token')).status, 401);
  });

  it('keeps executives away from the executive list and from creating more executives', async () => {
    const attempt = await api('POST', '/api/admin/executives', tokens.hk, {
      name: 'Sneaky', email: 'sneaky@example.com', password: 'Sneaky#12345', assignedPickupLocation: 'HK'
    });
    assert.equal(attempt.status, 403);
    assert.equal(await Admin.findOne({ email: 'sneaky@example.com' }), null);
  });
});

describe('pickup locations', () => {
  it('shows an admin both pods and an executive only theirs', async () => {
    const admin = await api('GET', '/api/admin/pickup-locations', tokens.boss);
    assert.deepEqual(admin.json.data.map((p) => p.key), ['HK', 'PC']);
    const hk = await api('GET', '/api/admin/pickup-locations', tokens.hk);
    assert.deepEqual(hk.json.data.map((p) => p.key), ['HK']);
    const pc = await api('GET', '/api/admin/pickup-locations', tokens.pc);
    assert.deepEqual(pc.json.data.map((p) => p.key), ['PC']);
    assert.equal(pc.json.data[0].name, PC);
    assert.equal(pc.json.data[0].latitude, 28.622834);
  });

  it('leaves what the driver app is offered unchanged (drivers do not choose a pickup point)', async () => {
    const result = await api('GET', '/api/drivers/pickup-locations');
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.data.locations.map((l) => l.name), [HK]);
  });
});

describe('rides, bookings and drivers are split by pod', () => {
  it('shows each executive only the rides of their pod, and the admin all of them', async () => {
    const hk = await api('GET', '/api/admin/rides?limit=100', tokens.hk);
    const pc = await api('GET', '/api/admin/rides?limit=100', tokens.pc);
    const all = await api('GET', '/api/admin/rides?limit=100', tokens.boss);
    assert.equal(hk.status, 200);

    const booths = (result) => [...new Set(result.json.data.rides.map((r) => r.pickupLocation))];
    assert.deepEqual(booths(hk), [HK]);
    assert.deepEqual(booths(pc), [PC]);
    assert.equal(hk.json.data.rides.length, 3); // 1 booking + 2 history
    assert.equal(pc.json.data.rides.length, 2); // 1 booking + 1 history
    assert.equal(all.json.data.rides.length, 5);
    assert.equal(hk.json.data.pagination.total, 3);
  });

  it('ignores a booth filter that asks for the other pod', async () => {
    const result = await api('GET', `/api/admin/rides?limit=100&booth=${encodeURIComponent(PC)}`, tokens.hk);
    assert.equal(result.status, 200);
    assert.ok(result.json.data.rides.every((r) => r.pickupLocation === HK));
  });

  it('splits the open bookings and the pending requests', async () => {
    for (const path of ['/api/admin/fleet-manager/open-bookings', '/api/admin/pending-fm-requests']) {
      const key = path.includes('open') ? 'bookings' : 'requests';
      const hk = await api('GET', path, tokens.hk);
      const pc = await api('GET', path, tokens.pc);
      const all = await api('GET', path, tokens.boss);
      assert.equal(hk.json[key].length, 1, path);
      assert.equal(pc.json[key].length, 1, path);
      assert.equal(all.json[key].length, 2, path);
      assert.equal(String(hk.json[key][0]._id), String(data.hkBooking._id));
      assert.equal(String(pc.json[key][0]._id), String(data.pcBooking._id));
    }
  });

  it('shows every driver to every executive (one shared pool), without identity or bank details', async () => {
    const hk = await api('GET', '/api/admin/drivers', tokens.hk);
    const pc = await api('GET', '/api/admin/drivers', tokens.pc);
    const all = await api('GET', '/api/admin/drivers', tokens.boss);

    assert.equal(hk.json.data.length, 6);
    assert.equal(pc.json.data.length, 6);
    assert.equal(all.json.data.length, 6);
    assert.deepEqual(hk.json.data.map((d) => d.fullName).sort(), all.json.data.map((d) => d.fullName).sort());

    for (const driver of [...hk.json.data, ...pc.json.data]) {
      assert.equal(driver.aadhaarNo, undefined);
      assert.equal(driver.bankDetails, undefined);
      assert.equal(driver.drivingLicenseNo, undefined);
      assert.equal(driver.password, undefined);
      assert.ok(driver.mobileNo, 'the phone number stays: it is needed to run the pickup point');
    }
    assert.ok(all.json.data[0].aadhaarNo, 'the admin still sees everything');
  });

  it('refuses booking details of the other pod and shows the own ones', async () => {
    const other = await api('GET', `/api/admin/fleet-manager/booking/${data.pcBooking._id}`, tokens.hk);
    assert.equal(other.status, 403);
    const own = await api('GET', `/api/admin/fleet-manager/booking/${data.hkBooking._id}`, tokens.hk);
    assert.equal(own.status, 200);
    const manual = await api('GET', `/api/admin/manual-booking/${data.pcBooking._id}`, tokens.hk);
    assert.equal(manual.status, 403);
    const admin = await api('GET', `/api/admin/fleet-manager/booking/${data.pcBooking._id}`, tokens.boss);
    assert.equal(admin.status, 200);
  });

  it('refuses to assign, cancel or resend for a booking of the other pod', async () => {
    const assign = await api('POST', `/api/admin/fleet-manager/assign-driver/${data.pcBooking._id}`, tokens.hk, { driverId: String(data.hkDriver._id) });
    assert.equal(assign.status, 403);
    const cancel = await api('POST', `/api/admin/fleet-manager/cancel-booking/${data.pcBooking._id}`, tokens.hk, { reason: 'x' });
    assert.equal(cancel.status, 403);
    const cancelFm = await api('POST', `/api/admin/cancel-fm-request/${data.pcBooking._id}`, tokens.hk);
    assert.equal(cancelFm.status, 403);
    const cancelPending = await api('POST', `/api/admin/cancel-pending/${data.pcBooking._id}`, tokens.hk, { reason: 'x' });
    assert.equal(cancelPending.status, 403);
    const resend = await api('POST', `/api/admin/resend-otp/${data.pcBooking._id}`, tokens.hk);
    assert.equal(resend.status, 403);

    const stored = await RideRequest.findById(data.pcBooking._id);
    assert.equal(stored.status, 'pending_fm', 'the other pod\'s booking is untouched');
    assert.equal(stored.targetDriverId, undefined);
  });

  it('lets an executive give their pod\'s booking to any driver: the ride carries the pod\'s pickup', async () => {
    // a driver who queued under the other pod's name can still be given a Hauz Khas booking
    const result = await api('POST', `/api/admin/fleet-manager/assign-driver/${data.hkBooking._id}`, tokens.hk, { driverId: String(data.pcDriver._id) });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const stored = await RideRequest.findById(data.hkBooking._id);
    assert.equal(String(stored.targetDriverId), String(data.pcDriver._id));
    assert.equal(stored.pickupLocation.boothName, HK, 'the driver is sent to the booking\'s pickup point');
  });

  it('lets the other executive do the same for their pod\'s booking', async () => {
    const result = await api('POST', `/api/admin/fleet-manager/assign-driver/${data.pcBooking._id}`, tokens.pc, { driverId: String(data.hkDriver._id) });
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const stored = await RideRequest.findById(data.pcBooking._id);
    assert.equal(String(stored.targetDriverId), String(data.hkDriver._id));
    assert.equal(stored.pickupLocation.boothName, PC);
  });
});

describe('driver online requests are shared by both pods', () => {
  it('shows every request to every executive and counts them all', async () => {
    const hk = await api('GET', '/api/admin/online-requests', tokens.hk);
    const pc = await api('GET', '/api/admin/online-requests', tokens.pc);
    const all = await api('GET', '/api/admin/online-requests', tokens.boss);
    assert.equal(hk.json.requests.length, 2);
    assert.equal(pc.json.requests.length, 2);
    assert.equal(all.json.requests.length, 2);
    assert.equal((await api('GET', '/api/admin/online-requests/count', tokens.hk)).json.pendingCount, 2);
    assert.equal((await api('GET', '/api/admin/online-requests/count', tokens.pc)).json.pendingCount, 2);
    assert.equal((await api('GET', `/api/admin/online-requests/by-booth/${encodeURIComponent(PC)}`, tokens.hk)).status, 200);
    assert.equal((await api('GET', '/api/admin/offline-requests', tokens.pc)).status, 200);
  });
});

describe('manual booking is pinned to the pod', () => {
  const booking = (extra = {}) => ({
    pickupStation: HK,
    pickupLocation: HK,
    dropLocation: 'India Gate, New Delhi',
    dropCoordinates: { lat: 28.6129, lng: 77.2295 },
    vehicleType: 'auto',
    estimatedFare: 150,
    distance: 8,
    userPhone: '9000000001',
    userName: 'Rider',
    existingUserId: undefined,
    paymentStatus: 'pending',
    paymentMethod: 'cash',
    fareBreakdown: { customerTotalFare: 150, driverFare: 130, baseFare: 120, gstAmount: 0, commissionAmount: 0 },
    ...extra
  });

  it('books the executive\'s own pod even when the request names the other one', async () => {
    const result = await api('POST', '/api/admin/submit-to-fleet-manager', tokens.pc, booking());
    assert.equal(result.status, 200, JSON.stringify(result.json));
    const created = await RideRequest.findOne({ bookingId: result.json.booking?.bookingId || result.json.bookingId });
    assert.ok(created, 'booking exists');
    assert.equal(created.pickupLocation.boothName, PC);
    assert.equal(Math.round(created.pickupLocation.latitude * 1e6) / 1e6, 28.622834);
  });

  it('lets an admin choose either pod', async () => {
    const pc = await api('POST', '/api/admin/submit-to-fleet-manager', tokens.boss, booking({ pickupStation: PC, pickupLocation: PC }));
    const hk = await api('POST', '/api/admin/submit-to-fleet-manager', tokens.boss, booking({ pickupStation: HK, pickupLocation: HK }));
    assert.equal(pc.status, 200, JSON.stringify(pc.json));
    assert.equal(hk.status, 200, JSON.stringify(hk.json));
    const idOf = (r) => r.json.booking?.bookingId || r.json.bookingId;
    assert.equal((await RideRequest.findOne({ bookingId: idOf(pc) })).pickupLocation.boothName, PC);
    assert.equal((await RideRequest.findOne({ bookingId: idOf(hk) })).pickupLocation.boothName, HK);
  });
});

describe('live updates are split by pod', () => {
  let boss;
  let hkExec;
  let pcExec;

  before(async () => {
    [boss, hkExec, pcExec] = await Promise.all([liveClient(tokens.boss), liveClient(tokens.hk), liveClient(tokens.pc)]);
  });

  it('puts executives only in their pod room and the admin in the admin rooms', () => {
    const roomsOf = (client) => [...(getIO().sockets.sockets.get(client.id)?.rooms || [])];
    const hkRooms = roomsOf(hkExec);
    const pcRooms = roomsOf(pcExec);
    const bossRooms = roomsOf(boss);
    assert.ok(hkRooms.includes('pod_HK'));
    assert.ok(!hkRooms.includes('pod_PC'));
    assert.ok(!hkRooms.includes('admins') && !hkRooms.includes('admin-room'), 'an executive never joins the all-pods rooms');
    assert.ok(pcRooms.includes('pod_PC'));
    assert.ok(!pcRooms.includes('pod_HK'));
    assert.ok(!pcRooms.includes('admins') && !pcRooms.includes('admin-room'));
    assert.ok(bossRooms.includes('admins') && bossRooms.includes('admin-room'));
    assert.ok(!bossRooms.some((room) => room.startsWith('pod_')), 'the admin gets everything through the admin rooms');
  });

  it('sends a new booking to the admin and to the executive of that pod only', async () => {
    const before = { boss: eventsOf(boss, 'newOpenBooking').length, hk: eventsOf(hkExec, 'newOpenBooking').length, pc: eventsOf(pcExec, 'newOpenBooking').length };
    const result = await api('POST', '/api/admin/submit-to-fleet-manager', tokens.hk, {
      pickupStation: HK,
      pickupLocation: HK,
      dropLocation: 'Qutub Minar, New Delhi',
      dropCoordinates: { lat: 28.5245, lng: 77.1855 },
      vehicleType: 'auto',
      estimatedFare: 110,
      distance: 6,
      userPhone: '9000000001',
      userName: 'Rider',
      paymentStatus: 'pending',
      paymentMethod: 'cash',
      fareBreakdown: { customerTotalFare: 110, driverFare: 95, baseFare: 90, gstAmount: 0, commissionAmount: 0 }
    });
    assert.equal(result.status, 200, JSON.stringify(result.json));

    assert.ok(await waitFor(() => eventsOf(hkExec, 'newOpenBooking').length > before.hk), 'HK executive got it');
    assert.ok(await waitFor(() => eventsOf(boss, 'newOpenBooking').length > before.boss), 'admin got it');
    await pause(200);
    assert.equal(eventsOf(pcExec, 'newOpenBooking').length, before.pc, 'PC executive did not');
    const seenByPc = JSON.stringify(pcExec.received);
    assert.ok(!seenByPc.includes('Qutub Minar'), 'nothing about the HK booking reached the PC executive');
  });

  it('sends driver events to both executives and the admin', async () => {
    notifyAdmins('driverStatusChanged', { driverId: String(data.pcDriver._id), driverName: data.pcDriver.fullName, isOnline: true, inQueue: true });
    assert.ok(await waitFor(() => eventsOf(pcExec, 'driverStatusChanged').length > 0), 'PC executive got it');
    assert.ok(await waitFor(() => eventsOf(hkExec, 'driverStatusChanged').length > 0), 'HK executive got it too: drivers are shared');
    assert.ok(await waitFor(() => eventsOf(boss, 'driverStatusChanged').length > 0), 'admin got it');
  });

  it('gives both executives the whole queue', async () => {
    notifyAdmins('queuePositionsUpdated', {
      queueUpdates: [
        { driverId: 'h1', driverName: 'First driver', currentMetroBooth: HK, queuePosition: 1 },
        { driverId: 'p1', driverName: 'Second driver', currentMetroBooth: PC, queuePosition: 2 }
      ],
      totalOnline: 2,
      action: 'test'
    });
    assert.ok(await waitFor(() => eventsOf(hkExec, 'queuePositionsUpdated').length > 0));
    assert.ok(await waitFor(() => eventsOf(pcExec, 'queuePositionsUpdated').length > 0));
    assert.ok(await waitFor(() => eventsOf(boss, 'queuePositionsUpdated').length > 0));
    for (const who of [hkExec, pcExec, boss]) {
      assert.deepEqual(eventsOf(who, 'queuePositionsUpdated').at(-1).queueUpdates.map((q) => q.driverName), ['First driver', 'Second driver']);
    }
  });

  it('lets either executive handle any driver request over the socket, in one shared queue', async () => {
    // Hauz Khas and Patel Chowk drivers are already #1 and #2. Each executive approves the OTHER pod's request.
    pcExec.emit('approveOnlineRequest', { requestId: String(data.hkRequest._id) });
    assert.ok(await waitFor(() => eventsOf(pcExec, 'approveOnlineRequestResult').some((r) => r.success)), 'PC executive approved the HK request');
    assert.equal((await Driver.findById(data.hkNewDriver._id)).queuePosition, 3, 'next place of the one queue');

    hkExec.emit('approveOnlineRequest', { requestId: String(data.pcRequest._id) });
    assert.ok(await waitFor(() => eventsOf(hkExec, 'approveOnlineRequestResult').some((r) => r.success)), 'HK executive approved the PC request');
    assert.equal((await Driver.findById(data.pcNewDriver._id)).queuePosition, 4);

    // nobody was renumbered
    assert.equal((await Driver.findById(data.hkDriver._id)).queuePosition, 1);
    assert.equal((await Driver.findById(data.pcDriver._id)).queuePosition, 2);

    // and both executives heard about both approvals
    assert.ok(await waitFor(() => eventsOf(hkExec, 'onlineRequestProcessed').length >= 2));
    assert.ok(await waitFor(() => eventsOf(pcExec, 'onlineRequestProcessed').length >= 2));
  });

  it('lets an executive take a driver out of the queue', async () => {
    pcExec.emit('adminRemoveFromQueue', { driverId: String(data.pcNewDriver._id), reason: 'test' });
    const removal = await waitFor(() => eventsOf(pcExec, 'adminRemoveFromQueueResult')[0]);
    assert.ok(removal && removal.success, JSON.stringify(removal));
    assert.equal((await Driver.findById(data.pcNewDriver._id)).inQueue, false);
  });
});

describe('drivers registered by an executive', () => {
  // Calls the registration handler the way the route does (the uploads are already stored: uploadResults)
  const register = (admin, n) => new Promise((resolve) => {
    const req = {
      admin,
      files: { aadhaarPhotoFront: [{}] },
      uploadResults: {
        aadhaarPhotoFront: '/uploads/a.jpg', aadhaarPhotoBack: '/uploads/b.jpg', driverSelfie: '/uploads/s.jpg',
        registrationCertificatePhoto: '/uploads/r.jpg', drivingLicensePhoto: '/uploads/d.jpg'
      },
      body: {
        fullName: `Registered Driver ${n}`, mobileNo: `97000000${n}`, aadhaarNo: `3000000000${n}`, vehicleNo: `DL1RG00${n}`,
        drivingLicenseNo: `DL-R-${n}`, password: 'driverpass1',
        accountHolderName: 'Test', accountNumber: '123456789012', ifscCode: 'SBIN0001234', bankName: 'Test Bank'
      }
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, json: payload }); return this; }
    };
    registerDriver(req, res);
  });

  it('are verified at once, so they can log in and go online without waiting for an admin', async () => {
    for (const [admin, n] of [[{ role: 'executive-manager', assignedPickupLocation: 'HK' }, '11'], [{ role: 'executive-manager', assignedPickupLocation: 'PC' }, '12']]) {
      const result = await register(admin, n);
      assert.equal(result.status, 201, JSON.stringify(result.json));
      assert.equal((await Driver.findOne({ mobileNo: `97000000${n}` })).isVerified, true);
    }
  });

  it('still wait for an admin to verify them when an admin registers them, or when they sign up themselves', async () => {
    const byAdmin = await register({ role: 'admin' }, '13');
    assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.json));
    assert.equal((await Driver.findOne({ mobileNo: '9700000013' })).isVerified, false);

    const selfSignup = await register(undefined, '14');
    assert.equal(selfSignup.status, 201, JSON.stringify(selfSignup.json));
    assert.equal((await Driver.findOne({ mobileNo: '9700000014' })).isVerified, false);
  });

  it('cannot be verified or unverified by an executive afterwards: that stays with the admin', async () => {
    const driver = await Driver.findOne({ mobileNo: '9700000013' });
    const result = await api('PUT', `/api/admin/drivers/${driver._id}/verify`, tokens.hk, { isVerified: true });
    assert.equal(result.status, 403);
    assert.equal((await Driver.findById(driver._id)).isVerified, false);
  });
});

describe('managing executives', () => {
  it('lists, validates, refuses duplicates and never returns a password', async () => {
    const list = await api('GET', '/api/admin/executives', tokens.boss);
    assert.equal(list.status, 200);
    assert.equal(list.json.data.length, 2);
    assert.ok(!JSON.stringify(list.json).includes('password'));
    assert.deepEqual(list.json.data.map((e) => e.assignedPickupLocation).sort(), ['HK', 'PC']);

    const create = (body) => api('POST', '/api/admin/executives', tokens.boss, body);
    assert.equal((await create({ name: 'X', email: 'not-an-email', password: 'LongEnough#1', assignedPickupLocation: 'HK' })).status, 400);
    assert.equal((await create({ name: 'X', email: 'x@example.com', password: 'short', assignedPickupLocation: 'HK' })).status, 400);
    assert.equal((await create({ name: 'X', email: 'x@example.com', password: 'LongEnough#1', assignedPickupLocation: 'ZZ' })).status, 400);
    assert.equal((await create({ name: '', email: 'x@example.com', password: 'LongEnough#1', assignedPickupLocation: 'HK' })).status, 400);
    assert.equal((await create({ name: 'Dup', email: 'hk.exec@example.com', password: 'LongEnough#1', assignedPickupLocation: 'HK' })).status, 409);
    assert.equal((await create({ name: 'Dup', email: 'boss@example.com', password: 'LongEnough#1', assignedPickupLocation: 'HK' })).status, 409);
  });

  it('stores the password hashed', async () => {
    const stored = await Admin.findOne({ email: 'hk.exec@example.com' }).select('+password');
    assert.notEqual(stored.password, 'HkExecPass#1');
    assert.ok(stored.password.startsWith('$2'));
  });

  it('does not let the executive routes touch admins', async () => {
    const boss = await Admin.findOne({ email: 'boss@example.com' });
    assert.equal((await api('PUT', `/api/admin/executives/${boss._id}`, tokens.boss, { name: 'Hacked' })).status, 404);
    assert.equal((await api('DELETE', `/api/admin/executives/${boss._id}`, tokens.boss)).status, 404);
    assert.equal((await Admin.findById(boss._id)).name, 'Boss');
  });

  it('moves an executive to the other pod and cuts their live connection so it reconnects there', async () => {
    const live = await liveClient(tokens.pc);
    let closed = false;
    live.on('disconnect', () => { closed = true; });

    const moved = await api('PUT', `/api/admin/executives/${data.pcExecId}`, tokens.boss, { assignedPickupLocation: 'HK' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.data.pod.key, 'HK');
    assert.ok(await waitFor(() => closed), 'the open connection was closed');

    // the same token now works for the new pod only
    const rides = await api('GET', '/api/admin/rides?limit=100', tokens.pc);
    assert.ok(rides.json.data.rides.every((r) => r.pickupLocation === HK));

    await api('PUT', `/api/admin/executives/${data.pcExecId}`, tokens.boss, { assignedPickupLocation: 'PC' });
  });

  it('deactivating an executive locks them out at once, reactivating lets them back', async () => {
    const live = await liveClient(tokens.hk);
    let closed = false;
    live.on('disconnect', () => { closed = true; });

    assert.equal((await api('PUT', `/api/admin/executives/${data.hkExecId}`, tokens.boss, { isActive: false })).status, 200);
    assert.ok(await waitFor(() => closed), 'live connection closed');
    assert.equal((await api('GET', '/api/admin/rides', tokens.hk)).status, 403, 'the old token no longer works');
    assert.equal((await login('hk.exec@example.com', 'HkExecPass#1')).status, 403, 'login is refused');
    await assert.rejects(liveClient(tokens.hk), 'no new live connection either');

    assert.equal((await api('PUT', `/api/admin/executives/${data.hkExecId}`, tokens.boss, { isActive: true })).status, 200);
    assert.equal((await api('GET', '/api/admin/rides', tokens.hk)).status, 200);
    assert.equal((await login('hk.exec@example.com', 'HkExecPass#1')).status, 200);
  });

  it('changes the password (old one stops working) and removes an executive', async () => {
    assert.equal((await api('PUT', `/api/admin/executives/${data.pcExecId}`, tokens.boss, { password: 'short' })).status, 400);
    assert.equal((await api('PUT', `/api/admin/executives/${data.pcExecId}`, tokens.boss, { password: 'BrandNewPass#9' })).status, 200);
    assert.equal((await login('pc.exec@example.com', 'PcExecPass#1')).status, 401);
    assert.equal((await login('pc.exec@example.com', 'BrandNewPass#9')).status, 200);

    assert.equal((await api('DELETE', `/api/admin/executives/${data.pcExecId}`, tokens.boss)).status, 200);
    assert.equal((await login('pc.exec@example.com', 'BrandNewPass#9')).status, 401);
    assert.equal((await api('GET', '/api/admin/rides', tokens.pc)).status, 401, 'a deleted executive\'s token is dead');
  });

  it('an executive without a pickup point is locked out until the admin sets one', async () => {
    await new Admin({ name: 'Lost', email: 'lost@example.com', password: 'LostPass#123', role: 'executive-manager' }).save();
    const login1 = await login('lost@example.com', 'LostPass#123');
    assert.equal(login1.status, 200, 'logging in works, so the screen can say what is wrong');
    const token = login1.json.token;
    assert.equal(login1.json.admin.pod, null);

    for (const path of ['/api/admin/rides?limit=100', '/api/admin/drivers', '/api/admin/fleet-manager/open-bookings', '/api/admin/online-requests']) {
      const result = await api('GET', path, token);
      assert.equal(result.status, 403, path);
      assert.match(result.json.error, /not linked to a pickup point/);
    }
    assert.equal((await api('GET', `/api/admin/fleet-manager/booking/${data.hkBooking._id}`, token)).status, 403);
  });
});
