'use strict';

/**
 * Pickup points ("pods") and executives: which booth belongs to which pod, what an executive may call, and how
 * live events and driver queues are split between the pods. No database needed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { listPods, getPod, podForBooth, boothNamesOf, normalizeBooth } = require('../../config/pickupPods');
const {
  isExecutive, podOf, canAccessBooth, boothCondition, resolveBookingPod, podRoomName, podRoomForBooth, NO_POD_MATCH
} = require('../../utils/podScope');
const { executiveMayCall } = require('../../middleware/executiveAccess');
const { directBooth, roomsForEvent, DRIVER_EVENTS } = require('../../utils/podEvents');

const HK = 'Hauz Khas Metro Gate No 1';
const PC = 'Patel Chowk Metro Station';

const hkExec = { role: 'executive-manager', assignedPickupLocation: 'HK' };
const pcExec = { role: 'executive-manager', assignedPickupLocation: 'PC' };
const lostExec = { role: 'executive-manager', assignedPickupLocation: null };
const boss = { role: 'admin' };
const superBoss = { role: 'super-admin' };

describe('pickup pods', () => {
  it('has exactly the two pods, with the names stored on existing rides', () => {
    const pods = listPods();
    assert.deepEqual(pods.map((p) => p.key), ['HK', 'PC']);
    assert.equal(getPod('HK').name, HK);
    assert.equal(getPod('pc').name, PC);
    assert.equal(getPod('XX'), null);
    assert.equal(getPod(null), null);
  });

  it('maps booth names (and their known spellings) to the right pod', () => {
    assert.equal(podForBooth(HK).key, 'HK');
    assert.equal(podForBooth(PC).key, 'PC');
    assert.equal(podForBooth('  hauz khas   metro gate no. 1 ').key, 'HK');
    assert.equal(podForBooth('Hauz Khas Metro Station Gate No 1').key, 'HK');
    assert.equal(podForBooth('Hauz Khas').key, 'HK');
    assert.equal(podForBooth('Patel Chowk').key, 'PC');
    assert.equal(podForBooth('Patel Chowk Metro Station Exit No 1').key, 'PC');
    assert.equal(podForBooth('Rajiv Chowk'), null);
    assert.equal(podForBooth(''), null);
    assert.equal(podForBooth(undefined), null);
  });

  it('never mixes the two pods up', () => {
    for (const name of boothNamesOf(getPod('HK'))) assert.equal(podForBooth(name).key, 'HK', name);
    for (const name of boothNamesOf(getPod('PC'))) assert.equal(podForBooth(name).key, 'PC', name);
    assert.equal(normalizeBooth('A--B  c'), 'a b c');
  });
});

describe('what an executive may see', () => {
  it('knows who is an executive and which pod they have', () => {
    assert.equal(isExecutive(hkExec), true);
    assert.equal(isExecutive(boss), false);
    assert.equal(isExecutive(superBoss), false);
    assert.equal(isExecutive(null), false);
    assert.equal(podOf(hkExec).key, 'HK');
    assert.equal(podOf(pcExec).key, 'PC');
    assert.equal(podOf(lostExec), null);
    assert.equal(podOf(boss), null);
  });

  it('lets admins see every booth and an executive only their own', () => {
    assert.equal(canAccessBooth(boss, HK), true);
    assert.equal(canAccessBooth(boss, PC), true);
    assert.equal(canAccessBooth(superBoss, 'anything'), true);
    assert.equal(canAccessBooth(hkExec, HK), true);
    assert.equal(canAccessBooth(hkExec, PC), false);
    assert.equal(canAccessBooth(pcExec, PC), true);
    assert.equal(canAccessBooth(pcExec, HK), false);
    // unknown or missing booths are never an executive's
    assert.equal(canAccessBooth(hkExec, ''), false);
    assert.equal(canAccessBooth(hkExec, undefined), false);
    assert.equal(canAccessBooth(hkExec, 'Rajiv Chowk'), false);
  });

  it('fails closed for an executive without a valid pod', () => {
    assert.equal(canAccessBooth(lostExec, HK), false);
    assert.equal(canAccessBooth(lostExec, PC), false);
    assert.deepEqual(boothCondition(lostExec, 'x'), { x: { $in: [NO_POD_MATCH] } });
    assert.equal(canAccessBooth({ role: 'executive-manager', assignedPickupLocation: 'ZZ' }, HK), false);
  });

  it('builds query conditions: nothing for admins, the pod\'s booth names for an executive', () => {
    assert.deepEqual(boothCondition(boss, 'pickupLocation.boothName'), {});
    const hk = boothCondition(hkExec, 'pickupLocation.boothName');
    assert.ok(hk['pickupLocation.boothName'].$in.includes(HK));
    assert.ok(!hk['pickupLocation.boothName'].$in.includes(PC));
    const pc = boothCondition(pcExec, 'boothName');
    assert.ok(pc.boothName.$in.includes(PC));
    assert.ok(!pc.boothName.$in.includes(HK));
  });

  it('pins a new booking to the executive\'s pod, whatever was asked for', () => {
    assert.equal(resolveBookingPod(hkExec, PC).key, 'HK');
    assert.equal(resolveBookingPod(pcExec, HK).key, 'PC');
    assert.equal(resolveBookingPod(lostExec, HK), null);
    assert.equal(resolveBookingPod(boss, PC).key, 'PC');
    assert.equal(resolveBookingPod(boss, 'HK').key, 'HK');
    assert.equal(resolveBookingPod(boss, undefined).key, 'HK');
  });

  it('has one live-update room per pod', () => {
    assert.equal(podRoomName('HK'), 'pod_HK');
    assert.equal(podRoomName(getPod('PC')), 'pod_PC');
    assert.equal(podRoomName('nope'), null);
    assert.equal(podRoomForBooth(PC), 'pod_PC');
    assert.equal(podRoomForBooth('Rajiv Chowk'), null);
  });
});

describe('executive route access list', () => {
  const allowed = [
    ['GET', '/api/admin/pickup-locations'],
    ['POST', '/api/admin/drivers'],
    ['GET', '/api/admin/drivers'],
    ['GET', '/api/admin/drivers?page=1'],
    ['GET', '/api/admin/rides?status=completed&limit=100'],
    ['GET', '/api/admin/check-user/9876543210'],
    ['POST', '/api/admin/register-customer'],
    ['POST', '/api/admin/submit-to-fleet-manager'],
    ['POST', '/api/admin/manual-booking'],
    ['GET', '/api/admin/manual-booking/abc123'],
    ['GET', '/api/admin/pending-fm-requests'],
    ['POST', '/api/admin/cancel-fm-request/abc123'],
    ['POST', '/api/admin/cancel-pending/abc123'],
    ['POST', '/api/admin/resend-otp/abc123'],
    ['POST', '/api/admin/send-payment-link'],
    ['GET', '/api/admin/offline-requests'],
    ['GET', '/api/admin/fleet-manager/open-bookings'],
    ['GET', '/api/admin/fleet-manager/booking/abc123'],
    ['POST', '/api/admin/fleet-manager/assign-driver/abc123'],
    ['POST', '/api/admin/fleet-manager/cancel-booking/abc123'],
    ['GET', '/api/admin/online-requests'],
    ['GET', '/api/admin/online-requests/count'],
    ['GET', '/api/admin/online-requests/by-booth/Patel%20Chowk'],
    ['POST', '/api/admin/online-requests/abc123/approve'],
    ['POST', '/api/admin/online-requests/abc123/reject'],
    ['POST', '/api/admin/online-requests/bulk-approve']
  ];

  const denied = [
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/users/abc123'],
    ['GET', '/api/admin/drivers/abc123'],
    ['DELETE', '/api/admin/drivers/abc123'],
    ['PUT', '/api/admin/drivers/abc123/verify'],
    ['GET', '/api/admin/dashboard/stats'],
    ['GET', '/api/admin/booths/performance'],
    ['GET', '/api/admin/financial/summary'],
    ['GET', '/api/admin/fare/fare-config'],
    ['PUT', '/api/admin/fare/fare-config/night-charge'],
    ['GET', '/api/admin/executives'],
    ['POST', '/api/admin/executives'],
    ['PUT', '/api/admin/executives/abc123'],
    ['DELETE', '/api/admin/executives/abc123'],
    ['GET', '/api/admin/queue/booths'],
    ['GET', '/api/admin/queue/live'],
    ['DELETE', '/api/admin/queue/booths/x/rides/y'],
    ['GET', '/api/admin/rides/abc123'],
    ['PUT', '/api/admin/rides/abc123/status'],
    ['GET', '/api/admin/rides/analytics/summary'],
    ['GET', '/api/admin/rides/booths/list'],
    ['POST', '/api/admin/ride-tools/force-status/abc123'],
    ['POST', '/api/admin/driver-recovery/execute'],
    ['GET', '/api/admin/sms-status'],
    ['GET', '/api/analytics/system/overview'],
    ['GET', '/api/drivers/debug/status'],
    // wrong verb on an allowed path
    ['DELETE', '/api/admin/rides'],
    ['PUT', '/api/admin/drivers'],
    ['GET', '/api/admin/submit-to-fleet-manager'],
    ['GET', '/api/admin/online-requests/abc123/approve'],
    // path tricks
    ['GET', '/api/admin//users'],
    ['GET', '/api/admin/drivers/../users'],
    ['GET', '/API/ADMIN/USERS'],
    ['GET', '/api/admin/drivers/abc/extra'],
    ['GET', '/api/admin/rides/../financial/summary'],
    ['POST', '/api/admin/fleet-manager/assign-driver/'],
    ['GET', ''],
    ['GET', undefined]
  ];

  for (const [method, url] of allowed) {
    it(`allows ${method} ${url}`, () => assert.equal(executiveMayCall(method, url), true));
  }
  for (const [method, url] of denied) {
    it(`refuses ${method} ${url}`, () => assert.equal(executiveMayCall(method, url), false));
  }
});

describe('live events', () => {
  it('finds the booth in a booking event payload', () => {
    assert.equal(directBooth({ boothName: PC }), PC);
    assert.equal(directBooth({ metroBooth: HK }), HK);
    assert.equal(directBooth({ pickupLocation: { boothName: PC } }), PC);
    assert.equal(directBooth({ pickupLocation: HK }), HK);
    assert.equal(directBooth({ request: { boothName: PC } }), PC);
    assert.equal(directBooth({ ride: { pickupLocation: { boothName: HK } } }), HK);
    assert.equal(directBooth({ driverId: 'x' }), '');
    assert.equal(directBooth(null), '');
    assert.equal(directBooth('text'), '');
  });

  it('sends driver and queue events to every executive, whatever pod the payload names', async () => {
    for (const event of DRIVER_EVENTS) {
      for (const payload of [{ boothName: HK }, { boothName: PC }, { driverId: 'x' }, {}]) {
        const rooms = await roomsForEvent(event, payload);
        assert.deepEqual(rooms.map((r) => r.room), ['executives'], event);
        assert.equal(rooms[0].data, payload, 'the payload is not cut down: the pool is shared');
      }
    }
    assert.ok(DRIVER_EVENTS.has('queuePositionsUpdated'));
    assert.ok(DRIVER_EVENTS.has('newOnlineRequest'));
  });

  it('sends booking events only to the executives of the pod the booking belongs to', async () => {
    const hk = await roomsForEvent('newOpenBooking', { pickupLocation: { boothName: HK } });
    const pc = await roomsForEvent('driverAcceptedFmBooking', { pickupLocation: PC });
    assert.deepEqual(hk.map((r) => r.room), ['pod_HK']);
    assert.deepEqual(pc.map((r) => r.room), ['pod_PC']);
    assert.deepEqual(await roomsForEvent('newOpenBooking', { pickupLocation: { boothName: 'Rajiv Chowk' } }), []);
  });
});
