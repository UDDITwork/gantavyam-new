// utils/podScope.js
// Pod ("pickup point") scoping for executives.
//
// Admins (roles "admin" and "super-admin") see and change everything. An executive ("executive-manager") is tied
// to ONE pod through admin.assignedPickupLocation and may only see or change the rides, bookings and booking
// live updates that belong to that pod. Drivers, the driver queue and the drivers' online / offline requests are
// one shared pool that every executive sees. Everything in this file fails closed: an executive without a valid
// pod matches no booking.

const { listPods, getPod, podForBooth, boothNamesOf, publicPod } = require('../config/pickupPods');

const EXECUTIVE_ROLE = 'executive-manager';

// A value no booth can have: filters built from it match no document
const NO_POD_MATCH = '__no_pod__';

const isExecutive = (admin) => !!admin && admin.role === EXECUTIVE_ROLE;

// The pod of an executive (null for admins and for an executive without a valid pod)
const podOf = (admin) => (isExecutive(admin) ? getPod(admin.assignedPickupLocation) : null);

// The booth name stored on a ride, queue entry, driver or request document / plain object
function bookingBooth(doc) {
  if (!doc) return '';
  if (typeof doc === 'string') return doc;
  const pickup = doc.pickupLocation;
  if (pickup && typeof pickup === 'object' && pickup.boothName) return pickup.boothName;
  if (typeof pickup === 'string' && pickup) return pickup;
  return doc.boothName || doc.metroBooth || doc.currentMetroBooth || '';
}

// Can this admin see / act on something that belongs to this booth?
function canAccessBooth(admin, booth) {
  if (!isExecutive(admin)) return true;
  const pod = podOf(admin);
  if (!pod) return false;
  const boothPod = podForBooth(booth);
  return !!boothPod && boothPod.key === pod.key;
}

const canAccessDoc = (admin, doc) => canAccessBooth(admin, bookingBooth(doc));

// A query condition for a booth field: {} for admins, the pod's booth spellings for an executive
function boothCondition(admin, field) {
  if (!isExecutive(admin)) return {};
  const pod = podOf(admin);
  const names = pod ? boothNamesOf(pod) : [NO_POD_MATCH];
  return { [field]: { $in: names } };
}

// The booth a new booking must be created at. Executives are always pinned to their own pod; an admin may pick
// either pod (by name or key) and gets the first pod when nothing is chosen.
function resolveBookingPod(admin, requested) {
  if (isExecutive(admin)) return podOf(admin);
  const wanted = getPod(requested) || podForBooth(requested);
  return wanted || listPods()[0];
}

function forbidden(res, message) {
  return res.status(403).json({
    success: false,
    error: message || 'This belongs to another pickup point',
    message: message || 'This belongs to another pickup point'
  });
}

// Socket.IO room that holds every executive (drivers and the queue are shared by both pods)
const EXECUTIVES_ROOM = 'executives';

// Socket.IO room of a pod's executives
const podRoomName = (podOrKey) => {
  const pod = typeof podOrKey === 'string' ? getPod(podOrKey) : podOrKey;
  return pod ? `pod_${pod.key}` : null;
};

// The room for the pod a booth belongs to (null when the booth is unknown)
const podRoomForBooth = (booth) => podRoomName(podForBooth(booth));

// What the client receives about an admin's pod
const publicPodOf = (admin) => publicPod(podOf(admin));

module.exports = {
  EXECUTIVE_ROLE,
  NO_POD_MATCH,
  isExecutive,
  podOf,
  publicPodOf,
  bookingBooth,
  canAccessBooth,
  canAccessDoc,
  boothCondition,
  resolveBookingPod,
  forbidden,
  EXECUTIVES_ROOM,
  podRoomName,
  podRoomForBooth
};
