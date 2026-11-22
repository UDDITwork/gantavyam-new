// Delivery of ride requests that an admin / Fleet Manager assigned to one specific driver.
//
// A request is stored on the RideRequest (targetDriverId, expiresAt, status "pending_fm" or "pending") and then
// pushed to the driver's app over Socket.IO. The push can miss: the driver's phone was locked, the network
// changed, or the backend was being redeployed. These helpers make sure the driver still gets the request as
// soon as their app is connected again, with a fresh response window, and only while it is still wanted.
const RideRequest = require('../models/RideRequest');

// Time the driver gets to answer once the request actually reaches their screen
const DRIVER_RESPONSE_MS = 60 * 1000;
// A request that never reached the driver is still delivered for this long after it was assigned
const LATE_DELIVERY_WINDOW_MS = 15 * 60 * 1000;
// Statuses in which a request is still waiting for its driver
const OPEN_STATUSES = ['pending', 'pending_fm'];

// What the driver app shows for a request (drivers only ever see their own earning, never the customer fare)
function buildDriverRidePayload(ride) {
  const driverFare = ride.driverFare || ride.fare || 0;
  const pickup = ride.pickupLocation || {};
  const drop = ride.dropLocation || {};
  return {
    _id: ride._id,
    rideId: ride.rideId || ride._id,
    bookingId: ride.bookingId,
    pickupLocation: { boothName: pickup.boothName, latitude: pickup.latitude, longitude: pickup.longitude },
    dropLocation: { address: drop.address, latitude: drop.latitude, longitude: drop.longitude },
    vehicleType: ride.vehicleType,
    driverFare,
    estimatedFare: driverFare,
    fare: driverFare,
    distance: ride.distance,
    startOTP: ride.startOTP,
    endOTP: ride.endOTP,
    userName: ride.userName,
    userPhone: ride.userPhone,
    status: 'pending',
    timestamp: ride.timestamp || new Date(),
    isManualBooking: true,
    bookingSource: 'manual',
    queueNumber: ride.queueNumber,
    expiresAt: ride.expiresAt // the driver dashboard counts down to this
  };
}

// Remembers that the driver's app confirmed it received the request (set once)
async function markDriverNotified(rideId) {
  try {
    await RideRequest.updateOne({ _id: rideId, driverNotifiedAt: null }, { $set: { driverNotifiedAt: new Date() } });
  } catch (error) {
    console.error('[driver-request-delivery] could not record the confirmation:', error.message);
  }
}

// The requests that should be on this driver's screen now:
//  - requests the driver has already seen and that are still inside their response window, and
//  - requests that never reached the driver (no confirmation) and were assigned recently. These get a fresh
//    response window, because the countdown should start when the driver can actually see the request.
async function collectDeliverableRequests(driverId, now = new Date()) {
  const rides = await RideRequest.find({
    targetDriverId: driverId,
    status: { $in: OPEN_STATUSES },
    bookingSource: 'manual'
  });

  const deliverable = [];
  for (const ride of rides) {
    const stillRunning = ride.expiresAt && ride.expiresAt > now;

    if (ride.driverNotifiedAt) {
      if (stillRunning) deliverable.push(ride);
      continue;
    }

    const assignedAt = ride.fmAssignedAt || ride.timestamp || ride.createdAt;
    const recent = assignedAt && now.getTime() - new Date(assignedAt).getTime() <= LATE_DELIVERY_WINDOW_MS;
    if (!stillRunning && !recent) continue;

    const freshExpiry = new Date(now.getTime() + DRIVER_RESPONSE_MS);
    if (!ride.expiresAt || ride.expiresAt < freshExpiry) {
      ride.expiresAt = freshExpiry;
      ride.isManualBookingExpired = false;
      await ride.save();
    }
    deliverable.push(ride);
  }
  return deliverable;
}

module.exports = {
  DRIVER_RESPONSE_MS,
  LATE_DELIVERY_WINDOW_MS,
  OPEN_STATUSES,
  buildDriverRidePayload,
  markDriverNotified,
  collectDeliverableRequests
};
