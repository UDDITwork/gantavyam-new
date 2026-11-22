// utils/podEvents.js
// Decides which executives receive a live admin event (admins always receive everything through the "admins" room).
//
//  - Drivers, the driver queue and the drivers' online / offline requests are ONE shared pool: every executive
//    gets those updates, whichever pickup point they belong to.
//  - Bookings and rides belong to a pickup point (pod): only the executives of THAT pod get those updates.
//
//   const deliveries = await roomsForEvent('newOpenBooking', payload);
//   // -> [{ room, data }]  the rooms that should receive the event, with the payload to send

const RideRequest = require('../models/RideRequest');
const RideHistory = require('../models/RideHistory');
const { podForBooth } = require('../config/pickupPods');
const { EXECUTIVES_ROOM, podRoomName } = require('./podScope');

// Events about the shared pool of drivers and their queue
const DRIVER_EVENTS = new Set([
  'driverStatusChanged',
  'driverStatusUpdated',
  'queuePositionsUpdated',
  'newOnlineRequest',
  'onlineRequestProcessed',
  'onlineRequestCancelled',
  'newOfflineRequest',
  'offlineRequestProcessed',
  'driverReconnected',
  'driverNotReachable',
  'driverOnline',
  'driverOffline',
  'driverWentOffline',
  'driverTimeoutRemoved'
]);

// Payload fields that carry a booth name, in the order they are tried
const BOOTH_FIELDS = ['boothName', 'metroBooth', 'currentMetroBooth', 'currentPickupLocation', 'previousBooth', 'pickupBooth', 'booth', 'pickupStation'];
// Payload fields that hold another object which may carry the booth
const NESTED_FIELDS = ['request', 'ride', 'rideData', 'booking'];

// The booth named in an event payload (one level of nesting), or ''
function directBooth(data, depth = 0) {
  if (!data || typeof data !== 'object') return '';
  for (const field of BOOTH_FIELDS) {
    if (typeof data[field] === 'string' && data[field]) return data[field];
  }
  const pickup = data.pickupLocation;
  if (typeof pickup === 'string' && pickup) return pickup;
  if (pickup && typeof pickup === 'object' && pickup.boothName) return pickup.boothName;
  if (depth === 0) {
    for (const field of NESTED_FIELDS) {
      const found = directBooth(data[field], 1);
      if (found) return found;
    }
  }
  return '';
}

const looksLikeId = (value) => /^[0-9a-f]{24}$/i.test(String(value || ''));

async function rideBooth(rideRef) {
  if (!rideRef) return '';
  try {
    const ref = String(rideRef);
    const ride = looksLikeId(ref)
      ? await RideRequest.findById(ref).select('pickupLocation')
      : await RideRequest.findOne({ rideId: ref }).select('pickupLocation');
    if (ride?.pickupLocation?.boothName) return ride.pickupLocation.boothName;
    const history = looksLikeId(ref)
      ? await RideHistory.findById(ref).select('pickupLocation')
      : await RideHistory.findOne({ rideId: ref }).select('pickupLocation');
    return history?.pickupLocation?.boothName || '';
  } catch (error) {
    return '';
  }
}

// The booth a booking / ride event is about: named in the payload, else the ride's pickup point
async function resolveBooth(data) {
  const direct = directBooth(data);
  if (direct) return direct;
  if (!data || typeof data !== 'object') return '';

  const fromRide = await rideBooth(data.rideId || data.rideRequestId || data.rideDbId || data._id);
  if (fromRide) return fromRide;
  return rideBooth(data.uniqueRideId);
}

// Which rooms receive this event (besides the admins), and with which payload
async function roomsForEvent(eventType, data) {
  if (DRIVER_EVENTS.has(eventType)) {
    return [{ room: EXECUTIVES_ROOM, data }];
  }
  const room = podRoomName(podForBooth(await resolveBooth(data)));
  return room ? [{ room, data }] : [];
}

module.exports = { roomsForEvent, resolveBooth, directBooth, DRIVER_EVENTS };
